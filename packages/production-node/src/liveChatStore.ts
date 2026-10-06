import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LiveChatMessage } from '@millionsnest/nestlive-production-domain';

export interface LiveChatQuery {
  organizationId: string;
  venueId: string;
  liveSystemId: string;
  liveSessionId: string;
  limit?: number;
}

export class LiveChatStore {
  private loaded = false;
  private messages: LiveChatMessage[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = 1200
  ) {}

  async append(message: LiveChatMessage): Promise<void> {
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<void>((resolve, reject) => {
      rejectResult = reject;
      this.writeQueue = this.writeQueue
        .then(async () => {
          await this.load();
          if (!this.messages.some(item => item.id === message.id)) {
            this.messages.push(structuredClone(message));
            if (this.messages.length > this.maxEntries) {
              this.messages = this.messages.slice(-this.maxEntries);
            }
            await this.persist();
          }
          resolve();
        })
        .catch(error => rejectResult(error));
    });
    return result;
  }

  async list(query: LiveChatQuery): Promise<LiveChatMessage[]> {
    await this.load();
    const limit = Math.max(1, Math.min(300, Math.floor(query.limit || 100)));
    return this.messages
      .filter(message =>
        message.organizationId === query.organizationId &&
        message.venueId === query.venueId &&
        message.liveSystemId === query.liveSystemId &&
        message.liveSessionId === query.liveSessionId
      )
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit)
      .map(message => structuredClone(message));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.messages = Array.isArray(parsed)
        ? parsed.filter(item =>
            item &&
            typeof item === 'object' &&
            typeof item.id === 'string' &&
            typeof item.liveSessionId === 'string' &&
            typeof item.text === 'string'
          ) as LiveChatMessage[]
        : [];
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.messages = [];
    }

    if (this.messages.length > this.maxEntries) {
      this.messages = this.messages.slice(-this.maxEntries);
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.messages, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
