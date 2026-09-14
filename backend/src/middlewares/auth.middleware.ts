import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { prisma } from "../config/prisma.js";
import { AUTH_COOKIE_NAME } from "../config/auth.js";
import {
  cacheAuthSession,
  claimSessionActivity,
  getCachedAuthSession,
  invalidateAuthSession,
} from "../platform/redis-runtime.js";

const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function reject(res: Response, status: number, message: string) {
  return res.status(status).json({ success: false, message });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[AUTH_COOKIE_NAME];
    if (typeof token !== "string" || token.length < 20 || token.length > 512) {
      return reject(res, 401, "Authentication required");
    }

    const tokenHash = hashToken(token);
    let session: any = await getCachedAuthSession(tokenHash);
    if (!session) {
      session = await prisma.session.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!session) {
        await invalidateAuthSession(tokenHash);
        return reject(res, 401, "Invalid session");
      }
      if (session.revokedAt) {
        await invalidateAuthSession(tokenHash);
        return reject(res, 401, "Session has been revoked");
      }
      if (session.expiresAt <= new Date()) {
        await invalidateAuthSession(tokenHash);
        return reject(res, 401, "Session expired");
      }
      if (session.user.status !== "ACTIVE") {
        await invalidateAuthSession(tokenHash);
        return reject(res, 403, "User account is not active");
      }
      await cacheAuthSession(tokenHash, session);
    }

    const now = Date.now();
    if (session.expiresAt.getTime() <= now) {
      await invalidateAuthSession(tokenHash);
      return reject(res, 401, "Session expired");
    }
    if (session.user.status !== "ACTIVE") {
      await invalidateAuthSession(tokenHash);
      return reject(res, 403, "User account is not active");
    }

    // The Redis control plane globally coalesces activity writes across API replicas. When it
    // is unavailable, the conditional database update preserves correctness without a write storm.
    const claimed = await claimSessionActivity(String(session.id));
    const lastUsed = session.lastUsedAt?.getTime() ?? 0;
    if (claimed === true || (claimed === null && now - lastUsed >= SESSION_ACTIVITY_WRITE_INTERVAL_MS)) {
      const threshold = new Date(now - SESSION_ACTIVITY_WRITE_INTERVAL_MS);
      await prisma.session.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }],
        },
        data: { lastUsedAt: new Date(now) },
      });
    }

    res.locals.user = session.user;
    res.locals.session = session;
    return next();
  } catch (error) {
    return next(error);
  }
}
