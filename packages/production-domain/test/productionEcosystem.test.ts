import { describe, expect, it } from 'vitest';
import {
  defineAdapterManifest,
  publicAdapterConfig,
  validateAdapterRegistration
} from '../src/adapterSdk';
import {
  assertFleetTenantIsolation,
  evaluateFailoverCandidate,
  failoverIdempotencyKey
} from '../src/productionEcosystem';

describe('adapter SDK', () => {
  const manifest = defineAdapterManifest({
    schemaVersion: 1,
    adapterKey: 'obs-websocket',
    displayName: 'OBS Studio',
    providerKind: 'broadcast',
    transport: 'websocket',
    capabilities: ['automation.trigger'],
    setup: [
      { key: 'url', label: 'URL', kind: 'url', required: true },
      { key: 'password', label: 'Password', kind: 'secret', required: true, secret: true }
    ],
    observedStateKeys: ['scene', 'streaming'],
    requiresLocalNode: true,
    secretsStayLocal: true,
    supportsOutputTargeting: false
  });

  it('validates registration and redacts secrets', () => {
    const registration = {
      manifest,
      instanceId: 'obs-main',
      displayName: 'OBS principal',
      config: { url: 'ws://127.0.0.1:4455', password: 'secret-value' }
    };
    expect(() => validateAdapterRegistration(registration)).not.toThrow();
    expect(publicAdapterConfig(registration)).toEqual({
      url: 'ws://127.0.0.1:4455',
      password: '[stored-in-os-vault]'
    });
  });

  it('rejects duplicate capabilities and unmarked secrets', () => {
    expect(() => defineAdapterManifest({
      ...manifest,
      capabilities: ['automation.trigger', 'automation.trigger']
    })).toThrow('adapter_capabilities_invalid');

    expect(() => defineAdapterManifest({
      ...manifest,
      setup: [{ key: 'password', label: 'Password', kind: 'secret', required: true }]
    })).toThrow('adapter_secret_field_must_be_marked');
  });
});

describe('production failover contract', () => {
  const plan = {
    id: 'plan-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    liveSystemId: 'system-1',
    title: 'Sunday',
    scheduledAt: '2026-09-27T19:00:00-03:00',
    revision: 4,
    items: []
  };

  it('allows only a healthy same-tenant node with the exact plan revision', () => {
    const decision = evaluateFailoverCandidate({
      source: {
        organizationId: 'org-1',
        venueId: 'venue-1',
        liveSystemId: 'system-1',
        servicePlanId: 'plan-1',
        servicePlanRevision: 4
      },
      candidate: {
        nodeId: 'node-b',
        organizationId: 'org-1',
        venueId: 'venue-1',
        liveSystemId: 'system-1',
        health: 'online',
        servicePlanId: 'plan-1',
        servicePlanRevision: 4
      },
      plan
    });
    expect(decision.eligible).toBe(true);
    expect(decision.commandNamespace).toBe('failover:plan-1:r4');
    expect(failoverIdempotencyKey({
      namespace: decision.commandNamespace!,
      originalIdempotencyKey: 'take-123'
    })).toBe('failover:plan-1:r4:take-123');
  });

  it('blocks cross-tenant failover and filters fleet views by tenant', () => {
    const decision = evaluateFailoverCandidate({
      source: {
        organizationId: 'org-1',
        venueId: 'venue-1',
        liveSystemId: 'system-1',
        servicePlanId: 'plan-1',
        servicePlanRevision: 4
      },
      candidate: {
        nodeId: 'node-other',
        organizationId: 'org-2',
        venueId: 'venue-1',
        liveSystemId: 'system-1',
        health: 'online',
        servicePlanId: 'plan-1',
        servicePlanRevision: 4
      },
      plan
    });
    expect(decision).toEqual({ eligible: false, reason: 'tenant_mismatch' });

    expect(assertFleetTenantIsolation('org-1', [
      { nodeId: 'a', organizationId: 'org-1', venueId: 'v', liveSystemId: 's', displayName: 'A', health: 'online', capabilities: [] },
      { nodeId: 'b', organizationId: 'org-2', venueId: 'v', liveSystemId: 's', displayName: 'B', health: 'online', capabilities: [] }
    ])).toHaveLength(1);
  });
});
