function ipv4IsPrivate(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }

  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
  );
}

export function isTrustedLiveWebOrigin(
  origin: string,
  configuredOrigins: ReadonlySet<string>
): boolean {
  if (configuredOrigins.has(origin)) return true;

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    if (
      url.protocol === 'https:' &&
      (host === 'millionsnest.com' || host.endsWith('.millionsnest.com'))
    ) {
      return true;
    }

    if (
      url.protocol === 'http:' &&
      (host === 'localhost' || host === '127.0.0.1' || host === '::1')
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export function normalizeLanPeerUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('peer_url_required');

  const withProtocol = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('unsupported_peer_protocol');
  }
  if (url.username || url.password) {
    throw new Error('peer_url_credentials_not_allowed');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowed =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    ipv4IsPrivate(host);

  if (!allowed) throw new Error('peer_must_be_local');

  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}
