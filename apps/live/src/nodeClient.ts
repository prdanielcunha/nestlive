import type { MeterFrame } from '@millionsnest/nestlive-domain';

export interface MeterSocketMessage {
  type: 'meter.frame';
  frame: MeterFrame;
}

export class NestLiveNodeMeterClient {
  private socket?: WebSocket;

  connect(input: {
    url: string;
    token: string;
    onFrame: (frame: MeterFrame) => void;
    onStatus?: (status: 'connecting' | 'online' | 'offline') => void;
  }): () => void {
    input.onStatus?.('connecting');
    const url = new URL(input.url);
    url.searchParams.set('token', input.token);

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => input.onStatus?.('online'));
    socket.addEventListener('close', () => input.onStatus?.('offline'));
    socket.addEventListener('error', () => input.onStatus?.('offline'));
    socket.addEventListener('message', event => {
      try {
        const parsed = JSON.parse(String(event.data)) as MeterSocketMessage;
        if (parsed.type === 'meter.frame') input.onFrame(parsed.frame);
      } catch {
        // Invalid telemetry is ignored instead of poisoning the Live UI.
      }
    });

    return () => {
      socket.close(1000, 'ui_disconnected');
      if (this.socket === socket) this.socket = undefined;
    };
  }
}
