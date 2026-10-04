import os from 'node:os';
import path from 'node:path';

export function defaultNestLiveStateDir(
  platform = process.platform,
  env = process.env
): string {
  if (env.NESTLIVE_STATE_DIR) return env.NESTLIVE_STATE_DIR;

  if (platform === 'win32') {
    return path.join(
      env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'NestLive'
    );
  }

  if (platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'NestLive'
    );
  }

  return path.join(
    env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
    'nestlive'
  );
}
