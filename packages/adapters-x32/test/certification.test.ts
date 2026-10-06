import { describe, expect, it } from 'vitest';
import {
  allX32DeepControlsCertified,
  certifiedX32DeepCapabilities,
  validateX32CertificationManifest
} from '../src';

const base = {
  schemaVersion: 1 as const,
  venueId: 'monte-castelo',
  providerInstanceId: 'x32-primary',
  targetAddress: '192.168.32.2',
  model: 'X32',
  firmware: '4.14',
  capabilities: [
    'audio.gain.write',
    'audio.phantom.write',
    'audio.eq.write',
    'audio.gate.write',
    'audio.compressor.write',
    'audio.scene.recall'
  ].map(capability => ({
    capability: capability as
      | 'audio.gain.write'
      | 'audio.phantom.write'
      | 'audio.eq.write'
      | 'audio.gate.write'
      | 'audio.compressor.write'
      | 'audio.scene.recall',
    result: 'pass' as const,
    evidence: `evidence:${capability}`
  }))
};

describe('X32 physical certification gate', () => {
  it('opens deep controls only for the exact certified console identity', () => {
    const manifest = validateX32CertificationManifest(base);
    const input = {
      providerInstanceId: 'x32-primary',
      targetAddress: '192.168.32.2',
      model: 'X32',
      firmware: '4.14'
    };

    expect(allX32DeepControlsCertified(manifest, input)).toBe(true);
    expect(certifiedX32DeepCapabilities(manifest, input).size).toBe(6);
    expect(
      allX32DeepControlsCertified(manifest, {
        ...input,
        firmware: '4.15'
      })
    ).toBe(false);
  });

  it('requires evidence for PASS entries', () => {
    expect(() =>
      validateX32CertificationManifest({
        ...base,
        capabilities: [
          {
            capability: 'audio.gain.write',
            result: 'pass',
            evidence: ''
          }
        ]
      })
    ).toThrow('x32_certification_evidence_required');
  });

  it('keeps untested controls closed', () => {
    const manifest = validateX32CertificationManifest({
      ...base,
      capabilities: base.capabilities.map(item => ({
        ...item,
        result:
          item.capability === 'audio.phantom.write'
            ? ('untested' as const)
            : item.result
      }))
    });

    expect(
      allX32DeepControlsCertified(manifest, {
        providerInstanceId: 'x32-primary',
        targetAddress: '192.168.32.2',
        model: 'X32',
        firmware: '4.14'
      })
    ).toBe(false);
  });
});
