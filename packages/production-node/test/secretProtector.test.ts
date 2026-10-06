import { describe, expect, it } from 'vitest';
import {
  MacOsKeychainSecretProtector,
  PlaintextAlphaSecretProtector,
  WindowsDpapiSecretProtector,
  createPlatformSecretProtector
} from '../src/secretProtector';

describe('secret protection', () => {
  it('selects the OS-backed secret provider where the release platform supports one', () => {
    expect(createPlatformSecretProtector('win32')).toBeInstanceOf(
      WindowsDpapiSecretProtector
    );
    expect(createPlatformSecretProtector('darwin')).toBeInstanceOf(
      MacOsKeychainSecretProtector
    );
    expect(createPlatformSecretProtector('linux')).toBeInstanceOf(
      PlaintextAlphaSecretProtector
    );
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;

  windowsIt('round-trips a secret with CurrentUser DPAPI without plaintext output at rest', async () => {
    const protector = new WindowsDpapiSecretProtector();
    const secret = 'holyrics-token-with-unicode-ç-🔒';
    const protectedValue = await protector.protect(secret, 'holyrics.token');

    expect(protectedValue).toMatch(/^dpapi:v1:/);
    expect(protectedValue).not.toContain(secret);
    expect(await protector.unprotect(protectedValue, 'holyrics.token')).toBe(secret);
  }, 20_000);

  const macIt = process.platform === 'darwin' ? it : it.skip;

  macIt('round-trips and deletes a provider secret in macOS Keychain', async () => {
    const protector = new MacOsKeychainSecretProtector();
    const purpose = `test.holyrics.token.${process.pid}.${Date.now()}`;
    const secret = 'mac-keychain-token-ç-🔐';
    const reference = await protector.protect(secret, purpose);

    try {
      expect(reference).toMatch(/^keychain:v1:/);
      expect(reference).not.toContain(secret);
      expect(await protector.unprotect(reference, purpose)).toBe(secret);
    } finally {
      await protector.delete(reference, purpose);
    }

    await expect(
      protector.unprotect(reference, purpose)
    ).rejects.toThrow(/macos_keychain_/);
  }, 20_000);
});
