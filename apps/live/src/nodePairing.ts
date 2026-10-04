import {
  normalizePrivateNodeUrl,
  type NestLiveNodeConnection
} from './audioNodeApiClient';

const CONNECTION_KEY = 'nestlive.audio.connection.v1';
const DEVICE_KEY = 'nestlive.device.id.v1';

export interface PairingChallenge {
  challengeId: string;
  expiresAt: string;
  displayedOnNode: true;
  nodeId?: string;
  method?: 'pin';
}

export interface PairingGrant {
  token: string;
  tokenId?: string;
  nodeId?: string;
  deviceName?: string;
}

function addressSpace(
  url: URL
): 'local' | 'loopback' {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' ||
    host === '::1' ||
    host.startsWith('127.')
    ? 'loopback'
    : 'local';
}

function deviceId(): string {
  const current = localStorage.getItem(DEVICE_KEY);
  if (current) return current;
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `device-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  localStorage.setItem(DEVICE_KEY, id);
  return id;
}

function deviceName(): string {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform =
    nav.userAgentData?.platform ||
    navigator.platform ||
    'Navegador';
  const touch = navigator.maxTouchPoints > 0 ? 'Touch' : 'Desktop';
  return `${platform} · ${touch}`;
}

async function pairingRequest<T>(
  baseUrlInput: string,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const baseUrl = normalizePrivateNodeUrl(baseUrlInput);
  const url = new URL(path, baseUrl);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      targetAddressSpace: addressSpace(url),
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    } as RequestInit & {
      targetAddressSpace?: 'local' | 'loopback';
    });

    const parsed = (await response.json().catch(() => ({}))) as T & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(parsed.error ?? `pairing_http_${response.status}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('node_timeout');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function pairingCandidateFromLocation(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const fromQr = params.get('pair');
  if (fromQr) {
    try {
      return normalizePrivateNodeUrl(fromQr);
    } catch {
      return undefined;
    }
  }

  const host = window.location.hostname.toLowerCase();
  const local =
    host === 'localhost' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (local && window.location.port === '4317') {
    return window.location.origin;
  }
  return undefined;
}

export async function beginNodePairing(
  baseUrlInput: string
): Promise<{
  baseUrl: string;
  challenge: PairingChallenge;
  deviceId: string;
  deviceName: string;
}> {
  const baseUrl = normalizePrivateNodeUrl(baseUrlInput);
  const id = deviceId();
  const name = deviceName();
  const challenge = await pairingRequest<PairingChallenge>(
    baseUrl,
    '/pairing/request',
    {
      deviceId: id,
      deviceName: name
    }
  );
  return {
    baseUrl,
    challenge,
    deviceId: id,
    deviceName: name
  };
}

export async function finishNodePairing(input: {
  baseUrl: string;
  challengeId: string;
  pin: string;
  deviceId: string;
  deviceName: string;
}): Promise<NestLiveNodeConnection> {
  const grant = await pairingRequest<PairingGrant>(
    input.baseUrl,
    '/pairing/complete',
    {
      challengeId: input.challengeId,
      pin: input.pin.replace(/\D/g, '').slice(0, 6),
      deviceId: input.deviceId,
      deviceName: input.deviceName
    }
  );

  const base = new URL(input.baseUrl);
  const meterPort =
    Number(base.port || (base.protocol === 'https:' ? 443 : 80)) === 4317
      ? 4319
      : Number(base.port || 4317) + 2;
  const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';

  return {
    httpBaseUrl: normalizePrivateNodeUrl(input.baseUrl),
    wsUrl: `${wsProtocol}//${base.hostname}:${meterPort}`,
    token: grant.token
  };
}

export function loadStoredNodeConnection():
  | NestLiveNodeConnection
  | undefined {
  try {
    const raw = localStorage.getItem(CONNECTION_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as NestLiveNodeConnection;
    if (!parsed.httpBaseUrl || !parsed.token) return undefined;
    return {
      ...parsed,
      httpBaseUrl: normalizePrivateNodeUrl(parsed.httpBaseUrl)
    };
  } catch {
    return undefined;
  }
}

export function saveStoredNodeConnection(
  connection: NestLiveNodeConnection
): void {
  localStorage.setItem(CONNECTION_KEY, JSON.stringify(connection));
}

export function clearStoredNodeConnection(): void {
  localStorage.removeItem(CONNECTION_KEY);
}
