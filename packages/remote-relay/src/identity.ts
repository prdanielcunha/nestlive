import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type {
  RemoteRelayIdentity,
  RemoteRelayScope
} from '@millionsnest/nestlive-domain';

export interface RelayVerifiedIdentity extends RemoteRelayIdentity {
  claims: Record<string, unknown>;
}

export interface RelayIdentityVerifier {
  verifyIdToken(token: string): Promise<RelayVerifiedIdentity>;
}

export interface RelayScopeAuthorizer {
  authorize(
    identity: RelayVerifiedIdentity,
    scope: RemoteRelayScope
  ): Promise<boolean>;
}

export class FirebaseAdminIdentityVerifier
  implements RelayIdentityVerifier
{
  constructor() {
    if (!getApps().length) initializeApp();
  }

  async verifyIdToken(token: string): Promise<RelayVerifiedIdentity> {
    const decoded = await getAuth().verifyIdToken(token, true);
    return {
      uid: decoded.uid,
      email:
        typeof decoded.email === 'string' ? decoded.email : undefined,
      claims: decoded as Record<string, unknown>
    };
  }
}

/**
 * Fail-closed scope authorizer.
 *
 * MillionsNest auth must mint an exact scope claim before Remote Mix can be
 * enabled. Example claim:
 *   nestliveScopes: ["orgId:venueId:liveSystemId"]
 *
 * No generic "authenticated user" fallback exists.
 */
export class FirebaseScopeClaimAuthorizer
  implements RelayScopeAuthorizer
{
  constructor(
    private readonly claimName = 'nestliveScopes'
  ) {}

  async authorize(
    identity: RelayVerifiedIdentity,
    scope: RemoteRelayScope
  ): Promise<boolean> {
    const value = identity.claims[this.claimName];
    if (!Array.isArray(value)) return false;

    const expected =
      `${scope.organizationId}:${scope.venueId}:${scope.liveSystemId}`;
    return value.some(item => item === expected);
  }
}
