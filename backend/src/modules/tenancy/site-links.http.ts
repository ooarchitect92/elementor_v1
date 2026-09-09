import { Router, type RequestHandler, type Request } from 'express';
import { WorkspaceError, assertWorkspaceMutation } from './workspace.core.js';
import type { WorkspaceRouterDependencies } from './workspace.http.js';
import { SiteLinkError, siteListCommand, siteMutationCommand, type SiteLinkCommand } from './site-links.policy.js';
import { runSiteLinkCommand } from './site-links.core.js';
export function createSiteLinkRouter(deps: WorkspaceRouterDependencies) {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(deps.authenticate, deps.selectTenant);
  const handle = (mutation: boolean, build: (req: Request) => SiteLinkCommand): RequestHandler => async (req, res) => {
    const traceId = deps.newId();
    res.setHeader('X-Workspace-Trace', traceId);
    try {
      const userId: unknown = res.locals.user?.id, sessionId: unknown = res.locals.session?.id, tenantId: unknown = res.locals.tenant?.tenantId;
      if (typeof userId !== 'string' || typeof sessionId !== 'string') throw new SiteLinkError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
      if (typeof tenantId !== 'string') throw new SiteLinkError(403, 'TENANT_ACCESS_DENIED', 'A verified tenant context is required');
      if (mutation) assertWorkspaceMutation(req.get('origin'), req.get('x-forgestudio-request'), req.get('content-type'), deps.trustedOrigin(), deps.production());
      const command = build(req);
      const result = await deps.transaction(tx => runSiteLinkCommand(tx, { userId, sessionId, tenantId, traceId }, command, deps.newId(), deps.newId()));
      // Resolving the transaction includes COMMIT, not just executing the insert.
      return res.status(result.created ? 201 : 200).json({ success: true, ...result, traceId });
    } catch (error) {
      if (error instanceof SiteLinkError || error instanceof WorkspaceError) return res.status(error.status).json({ success: false, code: error.code, message: error.message, traceId });
      deps.reportFailure?.(traceId);
      return res.status(503).json({ success: false, code: 'SITE_LINK_SERVICE_UNAVAILABLE', message: 'Website assignment could not be confirmed', traceId });
    }
  };
  router.get('/workspaces/:workspaceId', handle(false, req => siteListCommand(req.params.workspaceId, req.query as Record<string, unknown>)));
  router.put('/workspaces/:workspaceId/sites/:siteId', handle(true, req => siteMutationCommand('attach', req.params.workspaceId, req.params.siteId, req.body)));
  router.delete('/workspaces/:workspaceId/sites/:siteId', handle(true, req => siteMutationCommand('detach', req.params.workspaceId, req.params.siteId, req.body, req.get('if-match'))));
  return router;
}
