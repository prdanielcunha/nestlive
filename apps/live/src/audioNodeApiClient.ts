import type {
  AudioChannel,
  AudioCommandEnvelope,
  AudioCommandExecution,
  AudioControlCommand,
  AudioSafetyLevel
} from '@millionsnest/nestlive-domain';

export interface AudioProviderSummary {
  providerInstanceId: string;
  capabilities: string[];
}

export interface NestLiveNodeConnection {
  httpBaseUrl: string;
  wsUrl: string;
  token: string;
  providerInstanceId?: string;
}

export class NestLiveAudioApiClient {
  constructor(private readonly connection: NestLiveNodeConnection) {}

  private async request<T>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const response = await fetch(
      new URL(path, this.connection.httpBaseUrl),
      {
        ...init,
        headers: {
          authorization: `Bearer ${this.connection.token}`,
          'content-type': 'application/json',
          ...(init?.headers ?? {})
        }
      }
    );

    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(body.error ?? `node_http_${response.status}`);
    }
    return body;
  }

  async providers(): Promise<AudioProviderSummary[]> {
    const body = await this.request<{ providers: AudioProviderSummary[] }>(
      '/v1/audio/providers'
    );
    return body.providers;
  }

  async channels(providerInstanceId: string): Promise<AudioChannel[]> {
    const body = await this.request<{ channels: AudioChannel[] }>(
      `/v1/audio/providers/${encodeURIComponent(providerInstanceId)}/channels`
    );
    return body.channels;
  }

  async execute(input: {
    providerInstanceId: string;
    actorId: string;
    command: AudioControlCommand;
    confirmedSafetyLevel?: AudioSafetyLevel;
  }): Promise<AudioCommandExecution> {
    const envelope: AudioCommandEnvelope = {
      id: crypto.randomUUID(),
      actorId: input.actorId,
      providerInstanceId: input.providerInstanceId,
      createdAt: new Date().toISOString(),
      command: input.command,
      confirmedSafetyLevel: input.confirmedSafetyLevel
    };

    return this.request<AudioCommandExecution>(
      '/v1/audio/commands',
      {
        method: 'POST',
        body: JSON.stringify(envelope)
      }
    );
  }
}
