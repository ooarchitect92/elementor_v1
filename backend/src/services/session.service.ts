import { prisma } from "../config/prisma.js";
import { generateSessionToken, hashSessionToken } from "../utils/session.js";
import { createSession } from "../repositories/session.repository.js";
import { invalidateAuthSessions } from "../platform/redis-runtime.js";

const SESSION_DURATION_DAYS = 30;

export async function createUserSession(userId: string) {
  const rawToken = generateSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);
  await createSession({ userId, tokenHash, expiresAt });
  return { token: rawToken, expiresAt };
}

export async function createSupportSession(userId: string, durationMinutes: number = 120) {
  const rawToken = `supp_${generateSessionToken()}`;
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
  await createSession({ userId, tokenHash, expiresAt });
  return { supportToken: rawToken, expiresAt };
}

export async function revokeSupportSessions(userId: string) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null },
    select: { tokenHash: true },
  });
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await invalidateAuthSessions(sessions.map((session) => session.tokenHash));
  return result;
}
