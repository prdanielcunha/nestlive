import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
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


function inactive(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['archived', 'inactive', 'suspended', 'disabled'].includes(
    normalized
  );
}

/**
 * MillionsNest-compatible scope authorization.
 *
 * The relay verifies that the Firebase identity is an active member of the
 * organization. Venue/LiveSystem authority is still granted by the local
 * NestLive Node through a short-lived RemoteMixGrant bound to the exact scope
 * and actor uid, so organization membership alone can never operate a console.
 */
export class FirestoreMembershipScopeAuthorizer
  implements RelayScopeAuthorizer
{
  async authorize(
    identity: RelayVerifiedIdentity,
    scope: RemoteRelayScope
  ): Promise<boolean> {
    const db = getFirestore();
    const [orgDoc, memberDoc, userDoc] = await Promise.all([
      db.collection('organizations').doc(scope.organizationId).get(),
      db
        .collection(
          `organizations/${scope.organizationId}/members`
        )
        .doc(identity.uid)
        .get(),
      db.collection('users').doc(identity.uid).get()
    ]);

    const user = userDoc.data() ?? {};
    const systemRole = String(
      user.systemRole ?? user.role ?? ''
    ).toLowerCase();
    const privileged =
      systemRole === 'ceo' ||
      systemRole === 'super_admin' ||
      systemRole === 'superadmin';

    if (!orgDoc.exists) return false;
    const organization = orgDoc.data() ?? {};
    if (
      inactive(organization.status) ||
      organization.disabled === true
    ) {
      return false;
    }

    if (privileged) return true;
    if (!memberDoc.exists) return false;

    const member = memberDoc.data() ?? {};
    if (
      inactive(member.status) ||
      member.disabled === true ||
      member.active === false
    ) {
      return false;
    }

    const venueIds = Array.isArray(member.venueIds)
      ? member.venueIds.filter(
          (value): value is string => typeof value === 'string'
        )
      : [];
    if (
      venueIds.length > 0 &&
      !venueIds.includes(scope.venueId)
    ) {
      return false;
    }

    const liveSystemIds = Array.isArray(member.liveSystemIds)
      ? member.liveSystemIds.filter(
          (value): value is string => typeof value === 'string'
        )
      : [];
    if (
      liveSystemIds.length > 0 &&
      !liveSystemIds.includes(scope.liveSystemId)
    ) {
      return false;
    }

    return true;
  }
}
