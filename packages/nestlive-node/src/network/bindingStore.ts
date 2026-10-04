import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderNetworkBinding } from '@millionsnest/nestlive-domain';

interface BindingFile {
  version: 1;
  bindings: ProviderNetworkBinding[];
}

export class NetworkBindingStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<ProviderNetworkBinding[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as BindingFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
        throw new Error('binding_store_invalid');
      }
      return parsed.bindings;
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

  async get(
    providerInstanceId: string
  ): Promise<ProviderNetworkBinding | undefined> {
    return (await this.list()).find(
      binding => binding.providerInstanceId === providerInstanceId
    );
  }

  async save(binding: ProviderNetworkBinding): Promise<void> {
    const current = await this.list();
    const next = [
      ...current.filter(
        item => item.providerInstanceId !== binding.providerInstanceId
      ),
      binding
    ];
    await this.write(next);
  }

  async remove(providerInstanceId: string): Promise<void> {
    const current = await this.list();
    await this.write(
      current.filter(
        item => item.providerInstanceId !== providerInstanceId
      )
    );
  }

  private async write(
    bindings: ProviderNetworkBinding[]
  ): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(
      temp,
      JSON.stringify(
        { version: 1, bindings } satisfies BindingFile,
        null,
        2
      ),
      { encoding: 'utf8', mode: 0o600 }
    );
    await rename(temp, this.filePath);
  }
}
