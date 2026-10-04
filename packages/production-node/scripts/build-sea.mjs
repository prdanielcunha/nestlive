import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { inject } = require('postject');

const packageRoot = resolve(import.meta.dirname, '..');
const dist = join(packageRoot, 'dist');
const bundle = join(dist, 'index.cjs');
const blob = join(dist, 'sea-prep.blob');
const config = join(dist, 'sea-config.json');
const executable = join(
  dist,
  process.platform === 'win32' ? 'MusicScaleLiveNode.exe' : 'MusicScaleLiveNode'
);

await mkdir(dist, { recursive: true });
await rm(blob, { force: true });
await rm(executable, { force: true });

await writeFile(
  config,
  JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true
  }, null, 2)
);

execFileSync(process.execPath, ['--experimental-sea-config', config], {
  cwd: packageRoot,
  stdio: 'inherit'
});

await copyFile(process.execPath, executable);

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', executable], {
    stdio: 'inherit'
  });
}

// Use Postject's programmatic API instead of spawning `npx`.
// This keeps the SEA injection path identical across Windows/macOS/Linux and
// avoids Windows cmd shim/spawn semantics becoming part of the build contract.
await inject(
  executable,
  'NODE_SEA_BLOB',
  await readFile(blob),
  {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: 'NODE_SEA'
  }
);

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', executable], {
    stdio: 'inherit'
  });
}

console.log(JSON.stringify({
  event: 'sea_built',
  platform: process.platform,
  arch: process.arch,
  executable
}));
