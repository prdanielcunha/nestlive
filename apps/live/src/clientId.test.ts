import { describe, expect, it } from 'vitest';
import { createClientId } from './clientId';

describe('LAN browser identifiers', () => {
  it('creates RFC4122-style client IDs in the current browser context', () => {
    const first = createClientId();
    const second = createClientId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(second).not.toBe(first);
  });
});
