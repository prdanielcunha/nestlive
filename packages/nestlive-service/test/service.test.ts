import { describe, expect, it } from 'vitest';
import { buildServiceChildren } from '../src/main';

describe('NestLive service supervisor', () => {
  it('isolates the production engine and wires it behind the gateway', () => {
    const children = buildServiceChildren({
      NESTLIVE_PRODUCTION_ENTRY: '/tmp/production.cjs',
      NESTLIVE_AUDIO_ENTRY: '/tmp/audio.cjs',
      NESTLIVE_PRODUCTION_INTERNAL_TOKEN: 'shared-secret'
    });

    const production = children.find(item => item.name === 'production');
    const audio = children.find(item => item.name === 'audio');

    expect(production?.env.NESTLIVE_NODE_HOST).toBe('127.0.0.1');
    expect(production?.env.NESTLIVE_NODE_PORT).toBe('4337');
    expect(production?.env.NESTLIVE_DEV_TOKEN).toBe('shared-secret');
    expect(audio?.env.NESTLIVE_PRODUCTION_BASE_URL).toBe(
      'http://127.0.0.1:4337'
    );
    expect(
      audio?.env.NESTLIVE_PRODUCTION_INTERNAL_TOKEN
    ).toBe('shared-secret');
  });
});
