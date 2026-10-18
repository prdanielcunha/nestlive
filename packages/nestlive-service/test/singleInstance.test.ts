import { expect, it } from 'vitest';
import { portOccupied, reserveSupervisor } from '../src/singleInstance';
it('holds an exclusive loopback supervisor lock and detects a running gateway', async () => {
  const lock = await reserveSupervisor(0);
  const address = lock.address();
  if (!address || typeof address === 'string') throw new Error('address_missing');
  try {
    await expect(reserveSupervisor(address.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(await portOccupied(address.port)).toBe(true);
  } finally { await new Promise<void>(resolve => lock.close(() => resolve())); }
  expect(await portOccupied(address.port)).toBe(false);
});
