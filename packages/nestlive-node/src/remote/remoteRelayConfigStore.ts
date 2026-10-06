import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteRelayScope } from '@millionsnest/nestlive-domain';

export interface PersistedRemoteRelayConfig {
  version: 1;
  relayUrl: string;
  nodeTicket: string;
  scope: RemoteRelayScope;
  configuredAt: string;
}

export class RemoteRelayConfigStore {
  constructor(private readonly filePath: string) {}

  async get(): Promise<PersistedRemoteRelayConfig | undefined> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedRemoteRelayConfig;
      if (
        parsed.version !== 1 ||
        !parsed.relayUrl ||
        !parsed.nodeTicket ||
        !parsed.scope?.nodeId
      ) {
        throw new Error('remote_relay_config_invalid');
      }
      return parsed;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async save(input: Omit<PersistedRemoteRelayConfig, 'version'>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(
      temp,
      JSON.stringify({ version: 1, ...input }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
    await rename(temp, this.filePath);
  }

  async clear(): Promise<void> {
    await this.save({
      relayUrl: '',
      nodeTicket: '',
      scope: {
        nodeId: '',
        organizationId: '',
        venueId: '',
        liveSystemId: ''
      },
      configuredAt: new Date().toISOString()
    }).catch(() => undefined);
  }
}
