import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../src/idempotencyStore';

describe('IdempotencyStore', () => {
  it('returns the previously stored result for the same key', async () => {
    const store = new IdempotencyStore<number>(10_000);
    await store.set('same-command', 42);
    expect(store.get('same-command')).toBe(42);
  });

  it('does not confuse independent keys', async () => {
    const store = new IdempotencyStore<number>(10_000);
    await store.set('a', 1);
    await store.set('b', 2);
    expect(store.get('a')).toBe(1);
    expect(store.get('b')).toBe(2);
  });

  it('restores completed results after a Live Node restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-idempotency-'));
    const path = join(dir, 'commands.json');

    const first = new IdempotencyStore<{ accepted: boolean }>(60_000, 100, path);
    await first.load();
    await first.set('take-1', { accepted: true });

    const restarted = new IdempotencyStore<{ accepted: boolean }>(60_000, 100, path);
    await restarted.load();

    expect(restarted.get('take-1')).toEqual({ accepted: true });
  });

  it('coalesces concurrent retries so the producer runs once', async () => {
    const store = new IdempotencyStore<number>(60_000);
    let executions = 0;

    const producer = async () => {
      executions += 1;
      await new Promise(resolve => setTimeout(resolve, 15));
      return 7;
    };

    const [first, second, third] = await Promise.all([
      store.run('same-take', producer),
      store.run('same-take', producer),
      store.run('same-take', producer)
    ]);

    expect([first, second, third]).toEqual([7, 7, 7]);
    expect(executions).toBe(1);
  });

  it('fails closed after restart when a previous provider outcome is uncertain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-idempotency-'));
    const path = join(dir, 'commands.json');
    let executions = 0;

    const first = new IdempotencyStore<string>(60_000, 100, path);
    await expect(first.run('uncertain-take', async () => {
      executions += 1;
      throw new Error('provider_connection_lost_after_send');
    })).rejects.toThrow('provider_connection_lost_after_send');

    const restarted = new IdempotencyStore<string>(60_000, 100, path);
    await expect(restarted.run('uncertain-take', async () => {
      executions += 1;
      return 'must-not-run';
    })).rejects.toThrow('idempotency_previous_attempt_uncertain');

    expect(restarted.isUncertain('uncertain-take')).toBe(true);
    expect(executions).toBe(1);
  });

  it('does not replay a completed provider action after process restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-idempotency-'));
    const path = join(dir, 'commands.json');
    let providerExecutions = 0;

    const first = new IdempotencyStore<string>(60_000, 100, path);
    const original = await first.run('command-key', async () => {
      providerExecutions += 1;
      return 'observed-state-v1';
    });
    expect(original).toBe('observed-state-v1');

    const restarted = new IdempotencyStore<string>(60_000, 100, path);
    const retried = await restarted.run('command-key', async () => {
      providerExecutions += 1;
      return 'should-not-run';
    });

    expect(retried).toBe('observed-state-v1');
    expect(providerExecutions).toBe(1);
  });
});
