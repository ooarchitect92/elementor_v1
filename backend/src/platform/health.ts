import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.headers['x-request-id'];
  const id = typeof supplied === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied) ? supplied : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}
export function liveness(_req: Request, res: Response): void {
  res.status(200).json({status: 'alive'});
}
/** One in-flight query bounds probe amplification. A timeout doesn't imply DB cancellation. */
export function readiness(probe: () => Promise<unknown>, timeoutMs = 1500) {
  let pending: Promise<boolean> | null = null;
  return async (_req: Request, res: Response): Promise<void> => {
    if (!pending) pending = Promise.resolve().then(probe).then(() => true, () => false).finally(() => { pending = null; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const ready = await Promise.race([pending, timedOut]);
    if (timer) clearTimeout(timer);
    res.setHeader('Cache-Control','no-store');
    res.status(ready ? 200 : 503).json({status: ready ? 'ready' : 'not_ready', checks: {postgres: ready ? 'up' : 'unavailable'}});
  };
}
