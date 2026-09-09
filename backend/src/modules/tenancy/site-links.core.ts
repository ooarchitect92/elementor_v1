import { runWorkspaceCommand, type WorkspaceActor, type WorkspaceTx } from './workspace.core.js';
import { linkUuid, SiteLinkError, type SiteLinkCommand } from './site-links.policy.js';
interface LinkRow { id: string; tenant_id: string; workspace_id: string; site_id: string; created_at: Date }
interface SiteRow { id: string; name: string; slug: string; status: string; link_id?: string; linked_at?: Date }
const fail = (status: number, code: string, message: string): never => { throw new SiteLinkError(status, code, message); };
const serializeLink = (row: LinkRow) => ({ id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, siteId: row.site_id, createdAt: row.created_at.toISOString() });
export interface SiteLinkResult {
  sites?: { id: string; name: string; slug: string; status: string; linkId: string | null; linkedAt: string | null }[];
  nextCursor?: string | null;
  link?: ReturnType<typeof serializeLink>;
  created?: boolean;
  removed?: boolean;
}
/** Same transaction owns authorization, website lock, link and audit. No external I/O.
 * Links organize an owner's existing websites. They never grant editor access.
 */
export async function runSiteLinkCommand(tx: WorkspaceTx, rawActor: WorkspaceActor, command: SiteLinkCommand, newLinkId: string, auditId: string): Promise<SiteLinkResult> {
  const actor = { userId: linkUuid(rawActor.userId, 'userId'), sessionId: linkUuid(rawActor.sessionId, 'sessionId'), tenantId: linkUuid(rawActor.tenantId, 'tenantId'), traceId: linkUuid(rawActor.traceId, 'traceId') };
  const workspaceId = linkUuid(command.workspaceId, 'workspaceId');
  linkUuid(newLinkId, 'linkId'); linkUuid(auditId, 'auditId');
  // Reuses the tested session/account/membership locks, local scope and timeouts.
  // No authorization is derived from res.locals.role or a body/header identity.
  await runWorkspaceCommand(tx, actor, { kind: 'get', id: workspaceId }, auditId);
  const roles = await tx.$queryRaw<{ unsafe: boolean }[]>`
    SELECT (r.rolsuper OR r.rolbypassrls OR pg_has_role(current_user,c.relowner,'USAGE')
      OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity) AS unsafe
    FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
    WHERE r.rolname=current_user AND c.oid='platform.site_links'::regclass
  `;
  if (roles.length !== 1 || roles[0]?.unsafe !== false) fail(503, 'UNSAFE_DATABASE_ROLE', 'Site links require a non-owner role and forced row security');
  if (command.kind === 'list') {
    const rows = command.view === 'owned'
      ? await tx.$queryRaw<SiteRow[]>`
          SELECT s.id,s.name,s.slug,s.status FROM public.websites s
          WHERE s."userId"=${actor.userId}::uuid AND (${command.after}::uuid IS NULL OR s.id>${command.after}::uuid)
          ORDER BY s.id LIMIT ${command.limit + 1}
        `
      : await tx.$queryRaw<SiteRow[]>`
          SELECT s.id,s.name,s.slug,s.status,l.id AS link_id,l.created_at AS linked_at
          FROM platform.site_links l JOIN public.websites s ON s.id=l.site_id
          WHERE l.tenant_id=${actor.tenantId}::uuid AND l.workspace_id=${workspaceId}::uuid
            AND s."userId"=${actor.userId}::uuid AND (${command.after}::uuid IS NULL OR s.id>${command.after}::uuid)
          ORDER BY s.id LIMIT ${command.limit + 1}
        `;
    const page = rows.slice(0, command.limit);
    return { sites: page.map(row => ({ id: row.id, name: row.name, slug: row.slug, status: row.status, linkId: row.link_id ?? null, linkedAt: row.linked_at?.toISOString() ?? null })), nextCursor: rows.length > command.limit ? page.at(-1)?.id ?? null : null };
  }
  const memberships = await tx.$queryRaw<{ role: string }[]>`
    SELECT role FROM platform.memberships WHERE tenant_id=${actor.tenantId}::uuid AND user_id=${actor.userId}::uuid AND status='ACTIVE'
  `;
  // Membership/session rows remain share-locked by the workspace authorization.
  if (!['OWNER', 'ADMIN'].includes(memberships[0]?.role ?? '')) fail(403, 'LINK_PERMISSION_DENIED', 'Tenant OWNER or ADMIN membership is required');
  const workspaces = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM platform.workspaces WHERE tenant_id=${actor.tenantId}::uuid AND id=${workspaceId}::uuid FOR SHARE
  `;
  if (!workspaces[0]) fail(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
  if (command.kind === 'attach' && workspaces[0].status !== 'ACTIVE') fail(409, 'WORKSPACE_ARCHIVED', 'Restore the workspace before adding a website');
  const siteId = linkUuid(command.siteId, 'siteId');
  // Serializes all attach/detach/ownership-change/delete operations on this site.
  // Lock order is session/user -> membership/tenant -> workspace -> site.
  const sites = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM public.websites WHERE id=${siteId}::uuid AND "userId"=${actor.userId}::uuid FOR UPDATE
  `;
  if (sites.length !== 1) fail(404, 'SITE_NOT_AVAILABLE', 'Website is not available to this owner');
  const links = await tx.$queryRaw<LinkRow[]>`
    SELECT id,tenant_id,workspace_id,site_id,created_at FROM platform.site_links
    WHERE tenant_id=${actor.tenantId}::uuid AND site_id=${siteId}::uuid
  `;
  const existing = links[0];
  if (command.kind === 'attach') {
    if (existing) {
      if (existing.workspace_id !== workspaceId) fail(409, 'SITE_LINK_CONFLICT', 'Website cannot be linked here; review its existing assignment');
      return { link: serializeLink(existing), created: false };
    }
    const inserted = await tx.$queryRaw<LinkRow[]>`
      INSERT INTO platform.site_links(id,tenant_id,workspace_id,site_id,created_by)
      VALUES(${newLinkId}::uuid,${actor.tenantId}::uuid,${workspaceId}::uuid,${siteId}::uuid,${actor.userId}::uuid)
      ON CONFLICT DO NOTHING RETURNING id,tenant_id,workspace_id,site_id,created_at
    `;
    // Unique site_id spans tenants. RLS-hidden links return only a generic conflict.
    if (!inserted[0]) fail(409, 'SITE_LINK_CONFLICT', 'Website cannot be linked here; review its existing assignment');
    await tx.$executeRaw`INSERT INTO platform.audit_events(tenant_id,id,actor_id,action,resource_id,trace_id)
      VALUES(${actor.tenantId}::uuid,${auditId}::uuid,${actor.userId}::uuid,'workspace.site_linked',${siteId}::uuid,${actor.traceId}::uuid)`;
    return { link: serializeLink(inserted[0]), created: true };
  }
  const expected = linkUuid(command.linkId, 'linkId');
  if (!existing || existing.workspace_id !== workspaceId || existing.id !== expected) fail(412, 'SITE_LINK_CHANGED', 'Assignment changed or was removed; reload before retrying');
  const removed = await tx.$executeRaw`DELETE FROM platform.site_links
    WHERE tenant_id=${actor.tenantId}::uuid AND workspace_id=${workspaceId}::uuid AND site_id=${siteId}::uuid AND id=${expected}::uuid`;
  if (removed !== 1) fail(412, 'SITE_LINK_CHANGED', 'Assignment changed; reload before retrying');
  await tx.$executeRaw`INSERT INTO platform.audit_events(tenant_id,id,actor_id,action,resource_id,trace_id)
    VALUES(${actor.tenantId}::uuid,${auditId}::uuid,${actor.userId}::uuid,'workspace.site_unlinked',${siteId}::uuid,${actor.traceId}::uuid)`;
  return { removed: true };
}
