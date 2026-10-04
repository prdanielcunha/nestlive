import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

interface ServiceChild {
  name: string;
  entry: string;
  env: NodeJS.ProcessEnv;
}

function resolveEntry(
  explicit: string | undefined,
  workspaceRelative: string,
  packagedName: string
): string {
  if (explicit?.trim()) return path.resolve(explicit.trim());

  const packaged = path.resolve(
    path.dirname(process.execPath),
    packagedName
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
    'nestlive-production-node.cjs'
  );
  const audioEntry = resolveEntry(
    env.NESTLIVE_AUDIO_ENTRY,
    'packages/nestlive-node/dist/nestlive-node.cjs',
    'nestlive-audio-node.cjs'
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

  const processChild = spawn(
    process.execPath,
    [child.entry],
    {
      env: child.env,
      stdio: ['ignore', 'inherit', 'inherit']
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
  const children = buildServiceChildren();
  const running = children.map(spawnChild);

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
