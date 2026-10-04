import { hostname } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SimulatedAudioConsoleProvider } from '@millionsnest/nestlive-adapter-audio-sim';
import { X32AudioConsoleProvider } from '@millionsnest/nestlive-adapter-x32';
import {
  AccessTokenStore,
  AudioApiServer,
  defaultNestLiveStateDir,
  MeterWebSocketServer,
  NestLiveAudioRuntime,
  NestLiveDiscoveryBroadcaster,
  PairingManager
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
  const providerIds: string[] = [];

  const x32Target = process.env.NESTLIVE_X32_TARGET?.trim();
  if (x32Target) {
    const id = process.env.NESTLIVE_X32_ID || 'x32-primary';
    runtime.register(
      new X32AudioConsoleProvider({
        providerInstanceId: id,
        targetAddress: x32Target,
        localAddress:
          process.env.NESTLIVE_X32_LOCAL_ADDRESS?.trim() || undefined
      })
    );
    providerIds.push(id);
  } else if (process.env.NESTLIVE_SIMULATOR !== '0') {
    const id = 'sim-primary';
    runtime.register(new SimulatedAudioConsoleProvider(id));
    providerIds.push(id);
  }

  const authenticate = (token: string) => tokenStore.authenticate(token);

  const api = new AudioApiServer({
    port: HTTP_PORT,
    runtime,
    authenticate,
    pairing
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

  for (const providerId of providerIds) {
    await runtime.startMeters(providerId, 40);
  }

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
