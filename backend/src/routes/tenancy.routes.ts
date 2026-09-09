import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { prisma } from '../config/prisma.js';
import { getTenantContext, listTenantContexts, requireTenantContext } from '../modules/tenancy/tenant.middleware.js';
import { createWorkspaceRouter } from '../modules/tenancy/workspace.http.js';
import { createSiteLinkRouter } from '../modules/tenancy/site-links.http.js';

const router = Router();
router.get('/memberships', requireAuth, listTenantContexts);
router.get('/context', requireAuth, requireTenantContext, getTenantContext);
router.use('/workspaces', createWorkspaceRouter({
  authenticate: requireAuth,
  selectTenant: requireTenantContext,
  transaction: work => prisma.$transaction(tx => work(tx), { isolationLevel: 'ReadCommitted', maxWait: 2000, timeout: 6000 }),
  newId: randomUUID,
  trustedOrigin: () => process.env.FRONTEND_URL,
  production: () => process.env.NODE_ENV === 'production',
  reportFailure: traceId => console.error(JSON.stringify({ event: 'workspace_operation_failed', traceId })),
}));
router.use('/site-links', createSiteLinkRouter({
  authenticate: requireAuth,
  selectTenant: requireTenantContext,
  transaction: work => prisma.$transaction(tx => work(tx), { isolationLevel: 'ReadCommitted', maxWait: 2000, timeout: 6000 }),
  newId: randomUUID,
  trustedOrigin: () => process.env.FRONTEND_URL,
  production: () => process.env.NODE_ENV === 'production',
  reportFailure: traceId => console.error(JSON.stringify({ event: 'site_link_operation_failed', traceId })),
}));
export default router;
