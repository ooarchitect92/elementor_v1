/** Pure policy shared by requireAuth and its regression tests. */
export interface SessionPolicyInput {
  revokedAt: Date | null;
  expiresAt: Date;
  user: { status: string } | null;
}
export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}
export function sessionDenial(session: SessionPolicyInput | null, now = new Date()) {
  if (!session) return { status: 401, code: 'INVALID_SESSION', message: 'Invalid session' };
  if (session.revokedAt !== null) return { status: 401, code: 'SESSION_REVOKED', message: 'Session has been revoked' };
  const expires = session.expiresAt instanceof Date ? session.expiresAt.getTime() : NaN;
  if (!Number.isFinite(expires) || !Number.isFinite(now.getTime()) || expires <= now.getTime()) {
    return { status: 401, code: 'SESSION_EXPIRED', message: 'Session expired' };
  }
  if (session.user?.status !== 'ACTIVE') {
    return { status: 403, code: 'ACCOUNT_INACTIVE', message: 'Account is not active' };
  }
  return null;
}
