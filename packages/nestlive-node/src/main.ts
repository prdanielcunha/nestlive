import { hostname, networkInterfaces, platform } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { NetworkInterface } from '@millionsnest/nestlive-domain';
import { SimulatedAudioConsoleProvider } from '@millionsnest/nestlive-adapter-audio-sim';
import {
  allX32DeepControlsCertified,
  discoverX32OnSubnet,
  probeX32Reachability,
  validateX32CertificationManifest,
  X32AudioConsoleProvider
} from '@millionsnest/nestlive-adapter-x32';
import {
  AccessTokenStore,
  AudioApiServer,
  AudioProviderConfigStore,
  buildGuidedNetworkPlan,
  buildPreDiscoveryNetworkPlan,
  classifyNetworkHealth,
  createProviderNetworkBinding,
  defaultNestLiveStateDir,
  enumerateNetworkInterfaces,
  findBindingCandidates,
  inspectWindowsNetworkInterfaces,
  MeterWebSocketServer,
  NestLiveAudioRuntime,
  NetworkBindingStore,
  NestLiveDiscoveryBroadcaster,
  PairingManager,
  renderNestLiveLocalConsole,
  renderSoundcraftSpikeConsole,
  RemoteMixAuthority,
  RemoteMixTunnelClient,
  RemoteRelayConfigStore,
  ScaleAudioContextStore,
  SoundcraftSpikeCoordinator,
  validateProviderBinding
} from './index';

const HTTP_PORT = Number(process.env.NESTLIVE_HTTP_PORT || 4317);
const METER_PORT = Number(process.env.NESTLIVE_METER_PORT || 4319);
const STATE_DIR = defaultNestLiveStateDir();
const NODE_ID =
  process.env.NESTLIVE_NODE_ID ||
  `node_${createHash('sha256')
    .update(`${hostname()}|nestlive`)
    .digest('hex')
    .slice(0, 16)}`;
const DISPLAY_NAME =
  process.env.NESTLIVE_NODE_NAME ||
  `NestLive · ${hostname()}`;
const VERSION = '0.1.0';

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find(candidate =>
    existsSync(path.join(candidate, 'index.html'))
  );
}

const WEB_ROOT =
  process.env.NESTLIVE_WEB_ROOT?.trim() ||
  firstExisting([
    path.join(path.dirname(process.execPath), 'web'),
    path.resolve(process.cwd(), 'web'),
    path.resolve(process.cwd(), '../../apps/live/dist'),
    path.resolve(process.cwd(), 'apps/live/dist')
  ]);

const PRODUCTION_WEB_ROOT =
  process.env.NESTLIVE_PRODUCTION_WEB_ROOT?.trim() ||
  firstExisting([
    path.join(path.dirname(process.execPath), 'web-production'),
    path.resolve(process.cwd(), 'web-production'),
    path.resolve(process.cwd(), '../../apps/production/dist'),
    path.resolve(process.cwd(), 'apps/production/dist')
  ]);

async function loadX32DeepControlCertification(input: {
  providerInstanceId: string;
  targetAddress: string;
  model?: string;
  firmware?: string;
}): Promise<boolean> {
  const file = path.join(STATE_DIR, 'x32-certification.json');
  try {
    const manifest = validateX32CertificationManifest(
      JSON.parse(await readFile(file, 'utf8'))
    );
    return allX32DeepControlsCertified(manifest, input);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }

    console.log(
      JSON.stringify({
        event: 'x32_deep_controls_certification_rejected',
        reason:
          error instanceof Error ? error.message : 'invalid_manifest'
      })
    );
    return false;
  }
}

async function main(): Promise<void> {
  const tokenStore = new AccessTokenStore(
    path.join(STATE_DIR, 'access-tokens.json')
  );
  const providerConfigStore = new AudioProviderConfigStore(
    path.join(STATE_DIR, 'audio-providers.json')
  );
  const bindingStore = new NetworkBindingStore(
    path.join(STATE_DIR, 'network-bindings.json')
  );
  const soundcraftSpike = new SoundcraftSpikeCoordinator(
    path.join(STATE_DIR, 'certification')
  );
  const scaleAudioContext = new ScaleAudioContextStore(
    path.join(STATE_DIR, 'scale-audio-context.json')
  );
  const remoteMixAuthority = new RemoteMixAuthority(
    path.join(STATE_DIR, 'remote-mix-grants.json')
  );
  const remoteRelayConfigStore = new RemoteRelayConfigStore(
    path.join(STATE_DIR, 'remote-relay.json')
  );

  const pairing = new PairingManager(tokenStore, {
    nodeId: NODE_ID,
    onPin: value => {
      console.log(
        JSON.stringify({
          event: 'pairing_pin',
          deviceName: value.deviceName,
          pin: value.pin,
          expiresAt: value.expiresAt
        })
      );
    }
  });

  const runtime = new NestLiveAudioRuntime();
  const providerIds = new Set<string>();
  const remoteMixTunnel = new RemoteMixTunnelClient(
    remoteMixAuthority,
    runtime,
    () => providerIds.values().next().value as string | undefined
  );

  const inspectNetwork = async () => {
    if (platform() === 'win32') {
      return inspectWindowsNetworkInterfaces(NODE_ID);
    }

    const mapped = Object.fromEntries(
      Object.entries(networkInterfaces()).map(([name, addresses]) => [
        name,
        addresses?.map(item => ({
          address: item.address,
          family: item.family as 'IPv4' | 'IPv6',
          internal: item.internal,
          mac: item.mac,
          netmask: item.netmask,
          cidr: item.cidr
        }))
      ])
    );
    return enumerateNetworkInterfaces(NODE_ID, mapped);
  };

  const registerX32 = async (input: {
    targetAddress: string;
    localAddress: string;
    networkInterface?: NetworkInterface;
    persist: boolean;
  }) => {
    const id = process.env.NESTLIVE_X32_ID || 'x32-primary';
    if (runtime.hasProvider(id)) await runtime.removeProvider(id);

    let provider = new X32AudioConsoleProvider({
      providerInstanceId: id,
      targetAddress: input.targetAddress,
      localAddress: input.localAddress
    });

    const probe = await provider.probe();
    if (!probe.reachable) {
      await provider.dispose();
      throw new Error('x32_probe_failed');
    }

    const deepControlsCertified =
      await loadX32DeepControlCertification({
        providerInstanceId: id,
        targetAddress: input.targetAddress,
        model: probe.model,
        firmware: probe.firmware
      });

    if (deepControlsCertified) {
      await provider.dispose();
      provider = new X32AudioConsoleProvider({
        providerInstanceId: id,
        targetAddress: input.targetAddress,
        localAddress: input.localAddress,
        enableDeepControls: true
      });
      const certifiedProbe = await provider.probe();
      if (!certifiedProbe.reachable) {
        await provider.dispose();
        throw new Error('x32_certified_probe_failed');
      }
    }

    const networkSample = await probeX32Reachability({
      targetAddress: input.targetAddress,
      localAddress: input.localAddress,
      attempts: 5,
      timeoutMs: 450
    });

    if (!networkSample.reachable) {
      await provider.dispose();
      throw new Error('x32_bound_interface_unreachable');
    }

    runtime.register(provider);
    providerIds.add(id);
    await runtime.startTelemetry(id, 40);

    if (input.persist) {
      await providerConfigStore.save({
        kind: 'x32',
        providerInstanceId: id,
        targetAddress: input.targetAddress,
        localAddress: input.localAddress,
        networkInterfaceId: input.networkInterface?.id,
        networkMacAddress: input.networkInterface?.macAddress,
        updatedAt: new Date().toISOString()
      });

      if (input.networkInterface) {
        const binding = createProviderNetworkBinding({
          providerInstanceId: id,
          networkInterface: input.networkInterface,
          localAddress: input.localAddress,
          targetAddress: input.targetAddress,
          transport: 'udp',
          discoveryMethod: 'automatic'
        });
        await bindingStore.save({
          ...binding,
          health: classifyNetworkHealth(networkSample),
          lastValidatedAt: networkSample.checkedAt
        });
      }
    }

    return {
      providerInstanceId: id,
      state: await provider.getConsoleState(),
      deepControlsCertified,
      network: networkSample
    };
  };

  const configuredTarget = process.env.NESTLIVE_X32_TARGET?.trim();
  if (configuredTarget) {
    const localAddress =
      process.env.NESTLIVE_X32_LOCAL_ADDRESS?.trim();
    if (!localAddress) {
      throw new Error('x32_local_address_required_for_explicit_binding');
    }
    await registerX32({
      targetAddress: configuredTarget,
      localAddress,
      persist: false
    });
  } else {
    const persisted = (await providerConfigStore.list()).find(
      item => item.kind === 'x32'
    );
    if (persisted) {
      const interfaces = await inspectNetwork();
      const persistedInterface = persisted.networkInterfaceId
        ? interfaces.find(item => item.id === persisted.networkInterfaceId)
        : undefined;
      const samePhysicalAdapter =
        Boolean(persistedInterface) &&
        (!persisted.networkMacAddress ||
          !persistedInterface?.macAddress ||
          persistedInterface.macAddress.toLowerCase() ===
            persisted.networkMacAddress.toLowerCase());
      const plan = persistedInterface
        ? buildGuidedNetworkPlan(
            [persistedInterface],
            persisted.targetAddress
          )
        : undefined;
      const bindingCandidate = persistedInterface
        ? findBindingCandidates(
            [persistedInterface],
            persisted.targetAddress
          ).find(candidate =>
            candidate.localAddress === persisted.localAddress
          ) ??
          findBindingCandidates(
            [persistedInterface],
            persisted.targetAddress
          )[0]
        : undefined;
      const localAddress = bindingCandidate?.localAddress;

      if (
        persistedInterface &&
        samePhysicalAdapter &&
        plan?.readyForReadOnlyProbe &&
        localAddress
      ) {
        await registerX32({
          targetAddress: persisted.targetAddress,
          localAddress,
          networkInterface: persistedInterface,
          persist: true
        }).catch(error => {
          console.log(
            JSON.stringify({
              event: 'x32_recovery_waiting',
              error: error instanceof Error ? error.message : 'unknown'
            })
          );
        });
      } else {
        console.log(
          JSON.stringify({
            event: 'x32_recovery_requires_confirmation',
            reason: !persisted.networkInterfaceId
              ? 'legacy_binding_without_interface'
              : !persistedInterface
                ? 'bound_interface_missing'
                : !samePhysicalAdapter
                  ? 'physical_adapter_changed'
                  : 'bound_interface_no_longer_reaches_console'
          })
        );
      }
    }
  }

  if (
    runtime.listProviders().length === 0 &&
    process.env.NESTLIVE_SIMULATOR === '1'
  ) {
    const id = 'sim-primary';
    runtime.register(new SimulatedAudioConsoleProvider(id));
    providerIds.add(id);
    await runtime.startTelemetry(id, 40);
  }

  const persistedRelay = await remoteRelayConfigStore
    .get()
    .catch(() => undefined);
  if (persistedRelay) {
    await remoteMixTunnel
      .configure({
        relayUrl: persistedRelay.relayUrl,
        nodeTicket: persistedRelay.nodeTicket,
        scope: persistedRelay.scope
      })
      .catch(error => {
        console.log(
          JSON.stringify({
            event: 'remote_mix_relay_waiting',
            error: error instanceof Error ? error.message : 'unknown'
          })
        );
      });
  }

  const authenticate = (token: string) => tokenStore.authenticate(token);
  const authorize = (token: string) => tokenStore.authorize(token);

  const productionBaseUrl =
    process.env.NESTLIVE_PRODUCTION_BASE_URL?.trim();
  const productionToken =
    process.env.NESTLIVE_PRODUCTION_INTERNAL_TOKEN?.trim();

  const api = new AudioApiServer({
    port: HTTP_PORT,
    runtime,
    authenticate,
    authorize,
    revokeToken: token => tokenStore.revokeToken(token),
    activePairingCount: () => tokenStore.activeCount(),
    pairing,
    scaleAudioContext,
    remoteMixAuthority,
    remoteMixTunnel,
    remoteRelayConfigStore,
    soundcraftSpike,
    soundcraftSpikeHtml: () =>
      renderSoundcraftSpikeConsole(soundcraftSpike.status()),
    productionProxy:
      productionBaseUrl && productionToken
        ? {
            baseUrl: productionBaseUrl,
            token: productionToken
          }
        : undefined,
    inspectNetwork: async () => {
      const interfaces = await inspectNetwork();
      return {
        interfaces,
        bindings: await bindingStore.list(),
        plan: buildPreDiscoveryNetworkPlan(interfaces)
      };
    },
    discoverX32: async () => {
      const interfaces = await inspectNetwork();
      const plan = buildPreDiscoveryNetworkPlan(interfaces);
      if (!plan.readyForReadOnlyProbe || !plan.audioInterfaceId) {
        throw new Error('audio_interface_not_ready');
      }
      const audioInterface = interfaces.find(
        item => item.id === plan.audioInterfaceId
      );
      const localAddress = audioInterface?.ipv4[0];
      const cidr = audioInterface?.subnet.find(value => value.includes('.'));
      if (!audioInterface || !localAddress || !cidr) {
        throw new Error('audio_interface_ipv4_missing');
      }
      return discoverX32OnSubnet({ localAddress, cidr });
    },
    connectX32: async address => {
      const interfaces = await inspectNetwork();
      const plan = buildGuidedNetworkPlan(interfaces, address);
      if (!plan.readyForReadOnlyProbe || !plan.audioInterfaceId) {
        throw new Error('x32_target_not_reachable_by_audio_interface');
      }
      const audioInterface = interfaces.find(
        item => item.id === plan.audioInterfaceId
      );
      const localAddress = audioInterface?.ipv4[0];
      if (!audioInterface || !localAddress) {
        throw new Error('audio_interface_ipv4_missing');
      }
      return registerX32({
        targetAddress: address,
        localAddress,
        networkInterface: audioInterface,
        persist: true
      });
    },
    webRoot: WEB_ROOT,
    productionWebRoot: PRODUCTION_WEB_ROOT,
    localConsoleHtml: async () => {
      const interfaces = await inspectNetwork();
      const plan = buildPreDiscoveryNetworkPlan(interfaces);
      const cloudInterface = interfaces.find(
        item => item.id === plan.cloudInterfaceId
      );
      const address = cloudInterface?.ipv4[0];
      const nodeBase = address
        ? `http://${address}:${HTTP_PORT}`
        : undefined;
      // The QR uses the PWA served by the Node itself. It keeps pairing
      // same-origin, works without internet and avoids HTTPS→HTTP
      // private-network mixed-content restrictions on tablets.
      const preferredWebUrl = process.env.NESTLIVE_WEB_URL?.trim();
      const pairUrl = nodeBase
        ? preferredWebUrl
          ? `${preferredWebUrl.endsWith('/') ? preferredWebUrl.slice(0, -1) : preferredWebUrl}/?pair=${encodeURIComponent(nodeBase)}`
          : `${nodeBase}/`
        : undefined;

      return renderNestLiveLocalConsole({
        displayName: DISPLAY_NAME,
        pairUrl,
        pairings: pairing.localDisplay(),
        providers: runtime
          .listProviders()
          .map(item => item.providerInstanceId),
        soundcraftSpikeUrl:
          'http://127.0.0.1:' +
          HTTP_PORT +
          '/local/soundcraft-spike'
      });
    }
  });

  const meters = new MeterWebSocketServer({
    port: METER_PORT,
    authenticate,
    targetFps: 30
  });

  const discovery = new NestLiveDiscoveryBroadcaster({
    nodeId: NODE_ID,
    displayName: DISPLAY_NAME,
    httpPort: HTTP_PORT,
    meterPort: METER_PORT,
    version: VERSION,
    localAddress:
      process.env.NESTLIVE_DISCOVERY_LOCAL_ADDRESS?.trim() || undefined
  });

  await api.start();
  await discovery.start();

  const pump = setInterval(() => {
    for (const providerId of providerIds) {
      const frame = runtime.takeLatestMeter(providerId);
      if (frame) meters.publish(frame);
    }
  }, 16);

  let healthProbeRunning = false;
  const healthProbe = setInterval(() => {
    if (healthProbeRunning) return;
    healthProbeRunning = true;

    void (async () => {
      try {
        const interfaces = await inspectNetwork();
        const bindings = await bindingStore.list();

        for (const binding of bindings) {
          if (!runtime.hasProvider(binding.providerInstanceId)) continue;
          const networkInterface = interfaces.find(
            item => item.id === binding.networkInterfaceId
          );

          const updated = await validateProviderBinding(
            binding,
            networkInterface,
            async ({ localAddress, targetAddress, timeoutMs }) =>
              probeX32Reachability({
                localAddress,
                targetAddress,
                attempts: 4,
                timeoutMs
              })
          );
          await bindingStore.save(updated);
        }
      } catch (error) {
        console.log(
          JSON.stringify({
            event: 'network_health_probe_failed',
            error: error instanceof Error ? error.message : 'unknown'
          })
        );
      } finally {
        healthProbeRunning = false;
      }
    })();
  }, 5000);

  console.log(
    JSON.stringify({
      event: 'nestlive_node_ready',
      nodeId: NODE_ID,
      displayName: DISPLAY_NAME,
      httpPort: HTTP_PORT,
      meterPort: METER_PORT,
      providers: runtime.listProviders().map(item => item.providerInstanceId)
    })
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(pump);
    clearInterval(healthProbe);
    await discovery.stop().catch(() => undefined);
    await api.close().catch(() => undefined);
    await meters.close().catch(() => undefined);
    await remoteMixTunnel.disable().catch(() => undefined);
    await soundcraftSpike.dispose().catch(() => undefined);
    await runtime.dispose().catch(() => undefined);
    process.exit(0);
  };

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

void main().catch(error => {
  console.error(
    JSON.stringify({
      event: 'nestlive_node_failed',
      error: error instanceof Error ? error.message : 'unknown_error'
    })
  );
  process.exitCode = 1;
});
