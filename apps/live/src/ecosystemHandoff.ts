import { remoteCustomTokenSignIn } from './remoteAuth';

export interface NestLiveEcosystemContext {
  appId: 'nestlive';
  orgId: string;
  userId: string;
  customToken: string;
  expiresAt: number;
  supportMode: boolean;
  protocolVersion: '1.0.0';
}

const STORAGE_KEY = 'nestlive.ecosystem.context';
const MAX_TOKEN_CHARS = 16_384;

function decodeContext(value: string): unknown {
  try {
    return JSON.parse(atob(value));
  } catch {
    throw new Error('ecosystem_handoff_decode_failed');
  }
}

function cleanId(value: unknown, label: string): string {
  const next = typeof value === 'string' ? value.trim() : '';
  if (
    !next ||
    next.length > 256 ||
    next.includes('/') ||
    next.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(next)
  ) {
    throw new Error(`ecosystem_handoff_${label}_invalid`);
  }
  return next;
}

export function validateNestLiveEcosystemContext(
  value: unknown,
  now = Date.now()
): NestLiveEcosystemContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ecosystem_handoff_invalid');
  }

  const input = value as Record<string, unknown>;
  if (input.appId !== 'nestlive') {
    throw new Error('ecosystem_handoff_app_mismatch');
  }
  if (input.protocolVersion !== '1.0.0') {
    throw new Error('ecosystem_handoff_protocol_invalid');
  }
  if (typeof input.supportMode !== 'boolean') {
    throw new Error('ecosystem_handoff_support_mode_invalid');
  }

  const expiresAt = Number(input.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 10 * 60_000
  ) {
    throw new Error('ecosystem_handoff_expired_or_invalid');
  }

  const customToken =
    typeof input.customToken === 'string'
      ? input.customToken.trim()
      : '';
  if (
    !customToken ||
    customToken.length > MAX_TOKEN_CHARS
  ) {
    throw new Error('ecosystem_handoff_token_invalid');
  }

  return {
    appId: 'nestlive',
    orgId: cleanId(input.orgId, 'organization'),
    userId: cleanId(input.userId, 'user'),
    customToken,
    expiresAt,
    supportMode: input.supportMode,
    protocolVersion: '1.0.0'
  };
}

export function loadNestLiveEcosystemContext():
  | Omit<NestLiveEcosystemContext, 'customToken'>
  | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Omit<
      NestLiveEcosystemContext,
      'customToken'
    >;
    if (parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function consumeNestLiveEcosystemHandoff(
  href = window.location.href
): Promise<boolean> {
  const url = new URL(href);
  const encoded = url.searchParams.get('ecosystem_ctx');
  if (!encoded) return false;

  const context = validateNestLiveEcosystemContext(
    decodeContext(encoded)
  );

  const user = await remoteCustomTokenSignIn(
    context.customToken
  );
  if (user.uid !== context.userId) {
    throw new Error('ecosystem_handoff_user_mismatch');
  }

  const {
    customToken: _discarded,
    ...safeContext
  } = context;
  sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(safeContext)
  );

  url.searchParams.delete('ecosystem_ctx');
  history.replaceState(
    null,
    '',
    `${url.pathname}${url.search}${url.hash}`
  );
  return true;
}
