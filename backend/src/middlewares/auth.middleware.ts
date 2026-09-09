import type {
  Request,
  Response,
  NextFunction,
} from "express";
import crypto from "crypto";
import { prisma } from "../config/prisma.js";
import { AUTH_COOKIE_NAME } from "../config/auth.js";

const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const token = req.cookies?.[AUTH_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const tokenHash = hashToken(token);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session) {
      return res.status(401).json({ success: false, message: "Invalid session" });
    }
    if (session.revokedAt) {
      return res.status(401).json({ success: false, message: "Session has been revoked" });
    }
    if (session.expiresAt <= new Date()) {
      return res.status(401).json({ success: false, message: "Session expired" });
    }
    if (session.user.status !== "ACTIVE") {
      return res.status(403).json({ success: false, message: "User account is not active" });
    }

    // Authentication remains database-authoritative. Activity writes are coalesced so a
    // read-heavy authenticated session does not create a PostgreSQL write on every request.
    const now = Date.now();
    const lastUsed = session.lastUsedAt?.getTime() ?? 0;
    if (now - lastUsed >= SESSION_ACTIVITY_WRITE_INTERVAL_MS) {
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
    next();
  } catch (error) {
    next(error);
  }
}
