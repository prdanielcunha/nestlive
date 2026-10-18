import { portOccupied, reserveSupervisor } from './singleInstance';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

interface ServiceChild {
  name: string;
  entry: string;
  env: NodeJS.ProcessEnv;
}

function packagedBinary(baseName: string): string {
  return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}

function resolveEntry(
  explicit: string | undefined,
  workspaceRelative: string,
  packagedBaseName: string
): string {
  if (explicit?.trim()) return path.resolve(explicit.trim());

  const packaged = path.resolve(
    path.dirname(process.execPath),
    packagedBinary(packagedBaseName)
  );
  if (existsSync(packaged)) return packaged;

  return path.resolve(process.cwd(), workspaceRelative);
}

function sharedInternalToken(): string {
  const configured =
    process.env.NESTLIVE_PRODUCTION_INTERNAL_TOKEN?.trim();
  if (configured) return configured;
  return randomBytes(32).toString('base64url');
}

export function buildServiceChildren(
  env: NodeJS.ProcessEnv = process.env
): ServiceChild[] {
  const token =
    env.NESTLIVE_PRODUCTION_INTERNAL_TOKEN?.trim() ||
    sharedInternalToken();

  const productionEntry = resolveEntry(
    env.NESTLIVE_PRODUCTION_ENTRY,
    'packages/production-node/dist/index.cjs',
    'NestLiveProductionNode'
  );
  const audioEntry = resolveEntry(
    env.NESTLIVE_AUDIO_ENTRY,
    'packages/nestlive-node/dist/nestlive-node.cjs',
    'NestLiveAudioNode'
  );

  const productionPort =
    env.NESTLIVE_PRODUCTION_PORT?.trim() || '4337';

  return [
    {
      name: 'production',
      entry: productionEntry,
      env: {
        ...env,
        NESTLIVE_NODE_HOST: '127.0.0.1',
        NESTLIVE_NODE_PORT: productionPort,
        NESTLIVE_GATEWAY_PORT:
          env.NESTLIVE_HTTP_PORT?.trim() || '4317',
        NESTLIVE_DEV_TOKEN: token,
        NESTLIVE_PAIRING_ENABLED: 'false'
      }
    },
    {
      name: 'audio',
      entry: audioEntry,
      env: {
        ...env,
        NESTLIVE_HTTP_PORT:
          env.NESTLIVE_HTTP_PORT?.trim() || '4317',
        NESTLIVE_METER_PORT:
          env.NESTLIVE_METER_PORT?.trim() || '4319',
        NESTLIVE_PRODUCTION_BASE_URL:
          `http://127.0.0.1:${productionPort}`,
        NESTLIVE_PRODUCTION_INTERNAL_TOKEN: token
      }
    }
  ];
}

function spawnChild(child: ServiceChild): ChildProcess {
  if (!existsSync(child.entry)) {
    throw new Error(`nestlive_service_entry_missing:${child.name}:${child.entry}`);
  }

  const scriptEntry = /\.(?:c?js|mjs)$/i.test(child.entry);
  const executable = scriptEntry ? process.execPath : child.entry;
  const args = scriptEntry ? [child.entry] : [];

  const processChild = spawn(
    executable,
    args,
    {
      env: child.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true
    }
  );

  processChild.once('exit', (code, signal) => {
    if (code !== 0 && signal === null) {
      console.error(
        JSON.stringify({
          event: 'nestlive_subprocess_failed',
          name: child.name,
          code
        })
      );
    }
  });

  return processChild;
}

async function main(): Promise<void> {
  const gatewayPort = Number(process.env.NESTLIVE_HTTP_PORT || 4317);
  const productionPort = Number(process.env.NESTLIVE_PRODUCTION_PORT || 4337);
  let lock;
  try { lock = await reserveSupervisor(productionPort + 1); }
  catch (error: any) {
    if (error?.code === 'EADDRINUSE') {
      console.log(JSON.stringify({ event: 'nestlive_already_running', message: 'Outro supervisor já está ativo. Abra o painel existente.' }));
      return;
    }
    throw error;
  }
  if (await portOccupied(gatewayPort) || await portOccupied(productionPort)) {
    await new Promise<void>(resolve => lock.close(() => resolve()));
    console.error(JSON.stringify({ event: 'nestlive_port_in_use', gatewayPort, productionPort,
      message: 'MusicScale Live ou outro NestLive já está usando estas portas. Escolha uma única central; nenhum processo foi encerrado.' }));
    process.exitCode = 1;
    return;
  }
  const children = buildServiceChildren();
  const running: ChildProcess[] = [];
  try { for (const child of children) running.push(spawnChild(child)); }
  catch (error) {
    for (const child of running) child.kill('SIGTERM');
    lock.close();
    throw error;
  }

  console.log(
    JSON.stringify({
      event: 'nestlive_service_ready',
      children: children.map(child => child.name),
      gatewayPort: Number(process.env.NESTLIVE_HTTP_PORT || 4317),
      productionPort: Number(process.env.NESTLIVE_PRODUCTION_PORT || 4337)
    })
  );

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    lock.close();

    for (const child of running) {
      if (!child.killed) child.kill('SIGTERM');
    }

    const timeout = setTimeout(() => {
      for (const child of running) {
        if (!child.killed) child.kill('SIGKILL');
      }
      process.exit(0);
    }, 5000);
    timeout.unref();

    Promise.all(
      running.map(
        child =>
          new Promise<void>(resolve =>
            child.once('exit', () => resolve())
          )
      )
    ).then(() => process.exit(0));
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  for (const child of running) {
    child.once('exit', (code, signal) => {
      if (!stopping && (code !== 0 || signal)) {
        process.exitCode = code ?? 1;
        stop();
      }
    });
  }
}

if (process.env.VITEST !== 'true') {
  void main().catch(error => {
    console.error(
      JSON.stringify({
        event: 'nestlive_service_failed',
        error:
          error instanceof Error ? error.message : 'unknown_error'
      })
    );
    process.exitCode = 1;
  });
}
