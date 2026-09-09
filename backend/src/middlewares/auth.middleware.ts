import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../config/prisma.js';
import { AUTH_COOKIE_NAME } from '../config/auth.js';
import { isSessionToken, sessionDenial } from './session-policy.js';

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Never retain authority if this middleware is invoked again and fails.
  delete res.locals.user;
  delete res.locals.session;
  delete res.locals.tenant;
  try {
    const token: unknown = req.cookies?.[AUTH_COOKIE_NAME];
    if (!isSessionToken(token)) {
      return res.status(401).json({ success: false, code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await prisma.session.findUnique({ where: { tokenHash }, include: { user: true } });
    const denial = sessionDenial(session);
    if (denial) {
      return res.status(denial.status).json({ success: false, code: denial.code, message: denial.message });
    }
    if (!session) return; // Policy already returned a response for this case.
    await prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
    res.locals.user = session.user;
    res.locals.session = session;
    next();
  } catch (error) {
    next(error);
  }
}
