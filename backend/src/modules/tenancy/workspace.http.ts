import { Router, type Request, type Response, type RequestHandler } from 'express';
import {
  WorkspaceError, assertWorkspaceMutation, createWorkspaceCommand, listWorkspaceCommand,
  updateWorkspaceCommand, workspaceUuid, runWorkspaceCommand,
  type WorkspaceTx, type WorkspaceCommand,
} from './workspace.core.js';

export interface WorkspaceRouterDependencies {
  authenticate: RequestHandler;
  selectTenant: RequestHandler;
  transaction<T>(work: (tx: WorkspaceTx) => Promise<T>): Promise<T>;
  newId(): string;
  trustedOrigin(): string | undefined;
  production(): boolean;
  reportFailure?(traceId: string): void;
}
export function createWorkspaceRouter(deps: WorkspaceRouterDependencies) {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(deps.authenticate, deps.selectTenant);
  const handle = (mutation: boolean, build: (req: Request) => WorkspaceCommand): RequestHandler => async (req: Request, res: Response) => {
    const traceId = deps.newId();
    res.setHeader('X-Workspace-Trace', traceId);
    try {
      const userId: unknown = res.locals.user?.id;
      const sessionId: unknown = res.locals.session?.id;
      const tenantId: unknown = res.locals.tenant?.tenantId;
      if (typeof userId !== 'string' || typeof sessionId !== 'string') throw new WorkspaceError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
      if (typeof tenantId !== 'string') throw new WorkspaceError(403, 'TENANT_ACCESS_DENIED', 'A verified tenant context is required');
      if (mutation) assertWorkspaceMutation(req.get('origin'), req.get('x-forgestudio-request'), req.get('content-type'), deps.trustedOrigin(), deps.production());
      const command = build(req);
      // The response is not acknowledged until Prisma has committed this promise.
      const result = await deps.transaction(tx => runWorkspaceCommand(tx, { userId, sessionId, tenantId, traceId }, command, deps.newId()));
      if (result.replayed !== undefined) res.setHeader('Idempotent-Replayed', String(result.replayed));
      return res.status(command.kind === 'create' ? 201 : 200).json({ success: true, ...result, traceId });
    } catch (error) {
      if (error instanceof WorkspaceError) return res.status(error.status).json({ success: false, code: error.code, message: error.message, traceId });
      // Never return database errors, SQL parameters, connection URLs or session data.
      deps.reportFailure?.(traceId);
      return res.status(503).json({ success: false, code: 'WORKSPACE_SERVICE_UNAVAILABLE', message: 'Workspace operation could not be confirmed', traceId });
    }
  };
  router.get('/', handle(false, req => listWorkspaceCommand(req.query as Record<string, unknown>)));
  router.get('/:workspaceId', handle(false, req => ({ kind: 'get', id: workspaceUuid(req.params.workspaceId, 'workspaceId') })));
  router.post('/', handle(true, req => createWorkspaceCommand(req.body, req.get('idempotency-key'), deps.newId())));
  router.patch('/:workspaceId', handle(true, req => updateWorkspaceCommand(req.params.workspaceId, req.body)));
  return router;
}
