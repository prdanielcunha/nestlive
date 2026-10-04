import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LiveNodeProfile {
  version: 1;
  displayName: string;
  tutorialCompletedAt?: string;
  updatedAt: string;
}

function sanitizeDisplayName(value: string, fallback: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ');
  return normalized.slice(0, 64) || fallback;
}

export class NodeProfileStore {
  private loaded = false;
  private profile: LiveNodeProfile;

  constructor(
    private readonly filePath: string,
    private readonly fallbackName: string
  ) {
    this.profile = this.fresh();
  }

  async load(): Promise<LiveNodeProfile> {
    if (this.loaded) return structuredClone(this.profile);
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LiveNodeProfile>;
      this.profile = {
        version: 1,
        displayName: sanitizeDisplayName(
          typeof parsed.displayName === 'string' ? parsed.displayName : '',
          this.fallbackName
        ),
        ...(typeof parsed.tutorialCompletedAt === 'string'
          ? { tutorialCompletedAt: parsed.tutorialCompletedAt }
          : {}),
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date().toISOString()
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.profile = this.fresh();
    }
    this.loaded = true;
    return structuredClone(this.profile);
  }

  async setDisplayName(displayName: string): Promise<LiveNodeProfile> {
    await this.load();
    this.profile = {
      ...this.profile,
      displayName: sanitizeDisplayName(displayName, this.fallbackName),
      updatedAt: new Date().toISOString()
    };
    await this.persist();
    return structuredClone(this.profile);
  }

  async markTutorialComplete(): Promise<LiveNodeProfile> {
    await this.load();
    const now = new Date().toISOString();
    this.profile = {
      ...this.profile,
      tutorialCompletedAt: now,
      updatedAt: now
    };
    await this.persist();
    return structuredClone(this.profile);
  }

  private fresh(): LiveNodeProfile {
    return {
      version: 1,
      displayName: this.fallbackName,
      updatedAt: new Date(0).toISOString()
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.profile, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
