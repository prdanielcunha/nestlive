import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  RemoteRelayIdentity,
  RemoteRelayScope
} from '@millionsnest/nestlive-domain';

export interface NodeRelayTicketClaims {
  v: 1;
  kind: 'node';
  identity: RemoteRelayIdentity;
  scope: RemoteRelayScope;
  issuedAt: string;
  expiresAt: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function signature(secret: string, input: string): Buffer {
  return createHmac('sha256', secret).update(input).digest();
}

export class RelayTicketSigner {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error('remote_relay_signing_key_too_short');
    }
  }

  issueNodeTicket(input: {
    identity: RemoteRelayIdentity;
    scope: RemoteRelayScope;
    ttlMinutes?: number;
    now?: Date;
  }): string {
    const now = input.now ?? new Date();
    const ttlMinutes = Math.max(
      1,
      Math.min(240, Math.floor(input.ttlMinutes ?? 240))
    );
    const claims: NodeRelayTicketClaims = {
      v: 1,
      kind: 'node',
      identity: input.identity,
      scope: input.scope,
      issuedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + ttlMinutes * 60_000
      ).toISOString()
    };
    const header = encode({ alg: 'HS256', typ: 'NESTLIVE' });
    const payload = encode(claims);
    const body = `${header}.${payload}`;
    return `${body}.${signature(this.secret, body).toString('base64url')}`;
  }

  verifyNodeTicket(
    token: string,
    now = new Date()
  ): NodeRelayTicketClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('remote_relay_ticket_invalid');

    const body = `${parts[0]}.${parts[1]}`;
    const expected = signature(this.secret, body);
    const received = Buffer.from(parts[2]!, 'base64url');
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new Error('remote_relay_ticket_signature_invalid');
    }

    const claims = decode<NodeRelayTicketClaims>(parts[1]!);
    if (
      claims.v !== 1 ||
      claims.kind !== 'node' ||
      !claims.identity?.uid ||
      !claims.scope?.nodeId ||
      !claims.scope.organizationId ||
      !claims.scope.venueId ||
      !claims.scope.liveSystemId
    ) {
      throw new Error('remote_relay_ticket_claims_invalid');
    }
    if (new Date(claims.expiresAt).getTime() <= now.getTime()) {
      throw new Error('remote_relay_ticket_expired');
    }
    return claims;
  }
}
