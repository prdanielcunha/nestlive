import { describe, expect, it } from 'vitest';
import { RelayTicketSigner } from '../src';

const signer = new RelayTicketSigner('0123456789abcdef0123456789abcdef');

describe('RelayTicketSigner', () => {
  it('issues short-lived node tickets bound to exact scope', () => {
    const ticket = signer.issueNodeTicket({
      identity: { uid: 'tech-1' },
      scope: {
        nodeId: 'node-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        liveSystemId: 'live-1'
      },
      now: new Date('2026-10-06T18:00:00Z')
    });
    const claims = signer.verifyNodeTicket(
      ticket,
      new Date('2026-10-06T18:04:00Z')
    );
    expect(claims.scope.nodeId).toBe('node-1');
    expect(claims.identity.uid).toBe('tech-1');
  });

  it('rejects expired or tampered tickets', () => {
    const ticket = signer.issueNodeTicket({
      identity: { uid: 'tech-1' },
      scope: {
        nodeId: 'node-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        liveSystemId: 'live-1'
      },
      ttlMinutes: 1,
      now: new Date('2026-10-06T18:00:00Z')
    });
    expect(() =>
      signer.verifyNodeTicket(
        ticket,
        new Date('2026-10-06T18:02:00Z')
      )
    ).toThrow('remote_relay_ticket_expired');
    expect(() =>
      signer.verifyNodeTicket(ticket.slice(0, -2) + 'aa')
    ).toThrow();
  });
});
