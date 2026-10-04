import { describe, expect, it } from 'vitest';
import { isTrustedLiveWebOrigin, normalizeLanPeerUrl } from '../src/networkPolicy';

describe('Live Node web origin policy', () => {
  const configured = new Set(['https://preview.example.internal']);

  it('trusts current and future MillionsNest HTTPS subdomains', () => {
    expect(isTrustedLiveWebOrigin('https://musicscale.millionsnest.com', configured)).toBe(true);
    expect(isTrustedLiveWebOrigin('https://live.millionsnest.com', configured)).toBe(true);
    expect(isTrustedLiveWebOrigin('https://live.musicscale.millionsnest.com', configured)).toBe(true);
  });

  it('keeps arbitrary internet origins out', () => {
    expect(isTrustedLiveWebOrigin('https://evil.example', configured)).toBe(false);
    expect(isTrustedLiveWebOrigin('http://live.millionsnest.com', configured)).toBe(false);
  });

  it('allows explicitly configured preview origins and local development', () => {
    expect(isTrustedLiveWebOrigin('https://preview.example.internal', configured)).toBe(true);
    expect(isTrustedLiveWebOrigin('http://localhost:4316', configured)).toBe(true);
  });
});

describe('Live Node peer URL policy', () => {
  it('accepts LAN, loopback and mDNS node addresses', () => {
    expect(normalizeLanPeerUrl('192.168.1.40:4317')).toBe('http://192.168.1.40:4317');
    expect(normalizeLanPeerUrl('http://10.0.0.8:4317/node')).toBe('http://10.0.0.8:4317');
    expect(normalizeLanPeerUrl('live-led.local:4317')).toBe('http://live-led.local:4317');
    expect(normalizeLanPeerUrl('http://127.0.0.1:4317')).toBe('http://127.0.0.1:4317');
  });

  it('rejects arbitrary internet hosts and credential-bearing URLs', () => {
    expect(() => normalizeLanPeerUrl('https://example.com')).toThrow('peer_must_be_local');
    expect(() => normalizeLanPeerUrl('http://user:pass@192.168.1.40:4317')).toThrow(
      'peer_url_credentials_not_allowed'
    );
  });
});
