import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PeerNodeRecord {
  nodeId: string;
  baseUrl: string;
  token: string;
  displayName: string;
  organizationId: string;
  venueId: string;
  liveSystemId: string;
  pairedAt: string;
  lastSeenAt?: string;
}

interface PeerNodeFile {
  version: 1;
  peers: PeerNodeRecord[];
}

const EMPTY_FILE: PeerNodeFile = { version: 1, peers: [] };

export class PeerNodeStore {
  private loaded = false;
  private file: PeerNodeFile = structuredClone(EMPTY_FILE);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PeerNodeFile;
      this.file =
        parsed.version === 1 && Array.isArray(parsed.peers)
          ? {
              version: 1,
              peers: parsed.peers.filter(peer =>
                Boolean(
                  peer &&
                  typeof peer.nodeId === 'string' &&
                  peer.nodeId &&
                  typeof peer.baseUrl === 'string' &&
                  peer.baseUrl &&
                  typeof peer.token === 'string' &&
                  peer.token
                )
              )
            }
          : structuredClone(EMPTY_FILE);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.file = structuredClone(EMPTY_FILE);
    }
    this.loaded = true;
  }

  async all(): Promise<PeerNodeRecord[]> {
    await this.load();
    return structuredClone(this.file.peers);
  }

  async get(nodeId: string): Promise<PeerNodeRecord | null> {
    await this.load();
    const peer = this.file.peers.find(item => item.nodeId === nodeId);
    return peer ? structuredClone(peer) : null;
  }

  async upsert(peer: PeerNodeRecord): Promise<void> {
    await this.load();
    this.writeQueue = this.writeQueue.then(async () => {
      const next = this.file.peers.filter(item => item.nodeId !== peer.nodeId);
      next.push(structuredClone(peer));
      this.file = { version: 1, peers: next };
      await this.persist();
    });
    await this.writeQueue;
  }

  async touch(nodeId: string, lastSeenAt = new Date().toISOString()): Promise<void> {
    await this.load();
    const current = this.file.peers.find(item => item.nodeId === nodeId);
    if (!current) return;
    await this.upsert({ ...current, lastSeenAt });
  }

  async remove(nodeId: string): Promise<boolean> {
    await this.load();
    const exists = this.file.peers.some(item => item.nodeId === nodeId);
    if (!exists) return false;

    this.writeQueue = this.writeQueue.then(async () => {
      this.file = {
        version: 1,
        peers: this.file.peers.filter(item => item.nodeId !== nodeId)
      };
      await this.persist();
    });
    await this.writeQueue;
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
