import { hostname, networkInterfaces, platform } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SimulatedAudioConsoleProvider } from '@millionsnest/nestlive-adapter-audio-sim';
import {
  discoverX32OnSubnet,
  X32AudioConsoleProvider
} from '@millionsnest/nestlive-adapter-x32';
import {
  AccessTokenStore,
  AudioApiServer,
  AudioProviderConfigStore,
  buildGuidedNetworkPlan,
  buildPreDiscoveryNetworkPlan,
  defaultNestLiveStateDir,
  enumerateNetworkInterfaces,
  inspectWindowsNetworkInterfaces,
  MeterWebSocketServer,
  NestLiveAudioRuntime,
  NestLiveDiscoveryBroadcaster,
  PairingManager,
  renderNestLiveLocalConsole
} from './index';

const HTTP_PORT = Number(process.env.NESTLIVE_HTTP_PORT || 4317);
const METER_PORT = Number(process.env.NESTLIVE_METER_PORT || 4319);
const STATE_DIR = defaultNestLiveStateDir();
const NODE_ID =
  process.env.NESTLIVE_NODE_ID ||
  `node-${randomBytes(8).toString('hex')}`;
const DISPLAY_NAME =
  process.env.NESTLIVE_NODE_NAME ||
  `NestLive · ${hostname()}`;
const VERSION = '0.1.0';

async function main(): Promise<void> {
  const tokenStore = new AccessTokenStore(
    path.join(STATE_DIR, 'access-tokens.json')
  );
  const providerConfigStore = new AudioProviderConfigStore(
    path.join(STATE_DIR, 'audio-providers.json')
  );
  const pairing = new PairingManager(tokenStore, {
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
    networkInterfaceId?: string;
    persist: boolean;
  }) => {
    const id = process.env.NESTLIVE_X32_ID || 'x32-primary';
    if (runtime.hasProvider(id)) await runtime.removeProvider(id);

    const provider = new X32AudioConsoleProvider({
      providerInstanceId: id,
      targetAddress: input.targetAddress,
      localAddress: input.localAddress
    });

    const probe = await provider.probe();
    if (!probe.reachable) {
      await provider.dispose();
      throw new Error('x32_probe_failed');
    }

    runtime.register(provider);
    providerIds.add(id);
    await runtime.startMeters(id, 40);

    if (input.persist) {
      await providerConfigStore.save({
        kind: 'x32',
        providerInstanceId: id,
        targetAddress: input.targetAddress,
        localAddress: input.localAddress,
        networkInterfaceId: input.networkInterfaceId,
        updatedAt: new Date().toISOString()
      });
    }

    return {
      providerInstanceId: id,
      state: await provider.getConsoleState()
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
      const plan = buildGuidedNetworkPlan(
        interfaces,
        persisted.targetAddress
      );
      const audioInterface = interfaces.find(
        item => item.id === plan.audioInterfaceId
      );
      const localAddress = audioInterface?.ipv4[0];

      if (plan.readyForReadOnlyProbe && localAddress) {
        await registerX32({
          targetAddress: persisted.targetAddress,
          localAddress,
          networkInterfaceId: audioInterface.id,
          persist: true
        }).catch(error => {
          console.log(
            JSON.stringify({
              event: 'x32_recovery_waiting',
              error: error instanceof Error ? error.message : 'unknown'
            })
          );
        });
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
    await runtime.startMeters(id, 40);
  }

  const authenticate = (token: string) => tokenStore.authenticate(token);

  const productionBaseUrl =
    process.env.NESTLIVE_PRODUCTION_BASE_URL?.trim();
  const productionToken =
    process.env.NESTLIVE_PRODUCTION_INTERNAL_TOKEN?.trim();

  const api = new AudioApiServer({
    port: HTTP_PORT,
    runtime,
    authenticate,
    pairing,
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
        networkInterfaceId: audioInterface.id,
        persist: true
      });
    },
    localConsoleHtml: async () => {
      const interfaces = await inspectNetwork();
      const plan = buildPreDiscoveryNetworkPlan(interfaces);
      const cloudInterface = interfaces.find(
        item => item.id === plan.cloudInterfaceId
      );
      const address = cloudInterface?.ipv4[0];
      const webUrl =
        process.env.NESTLIVE_WEB_URL?.trim() ||
        'https://nestlive.millionsnest.com';
      const nodeBase = address
        ? `http://${address}:${HTTP_PORT}`
        : undefined;
      const pairUrl = nodeBase
        ? `${webUrl}/?pair=${encodeURIComponent(nodeBase)}`
        : undefined;

      return renderNestLiveLocalConsole({
        displayName: DISPLAY_NAME,
        pairUrl,
        pairings: pairing.localDisplay(),
        providers: runtime
          .listProviders()
          .map(item => item.providerInstanceId)
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
    await discovery.stop().catch(() => undefined);
    await api.close().catch(() => undefined);
    await meters.close().catch(() => undefined);
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
