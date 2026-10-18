import { expect, it, vi } from 'vitest';
import { cachedInspector } from '../src/network/cachedInspector';
it('shares concurrent Windows inspections and refreshes after TTL, never caches failures', async () => {
  let now = 100;
  const inspect = vi.fn(async () => ['network']);
  const read = cachedInspector(inspect, 10000, () => now);
  await Promise.all(Array.from({length:10}, () => read()));
  expect(inspect).toHaveBeenCalledTimes(1);
  now += 9999; await read(); expect(inspect).toHaveBeenCalledTimes(1);
  now += 2; await read(); expect(inspect).toHaveBeenCalledTimes(2);
  const fail = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue('ok');
  const recover = cachedInspector(fail);
  await expect(recover()).rejects.toThrow('network');
  expect(await recover()).toBe('ok');
});
