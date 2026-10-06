import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface X32PersistedConfig {
  kind: 'x32';
  providerInstanceId: string;
  targetAddress: string;
  localAddress: string;
  networkInterfaceId?: string;
  networkMacAddress?: string;
  updatedAt: string;
}

export type PersistedAudioProviderConfig = X32PersistedConfig;

interface ProviderConfigFile {
  version: 1;
  providers: PersistedAudioProviderConfig[];
}

export class AudioProviderConfigStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<PersistedAudioProviderConfig[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ProviderConfigFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.providers)) {
        throw new Error('audio_provider_config_invalid');
      }
      return parsed.providers;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
  }

  async save(config: PersistedAudioProviderConfig): Promise<void> {
    const current = await this.list();
    const next = [
      ...current.filter(
        item => item.providerInstanceId !== config.providerInstanceId
      ),
      config
    ];
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(
      temp,
      JSON.stringify(
        { version: 1, providers: next } satisfies ProviderConfigFile,
        null,
        2
      ),
      { encoding: 'utf8', mode: 0o600 }
    );
    await rename(temp, this.filePath);
  }
}
