export interface LinkedSite { id: string; name: string; slug: string; status: string; linkId: string | null; linkedAt: string | null }
export interface SitePage { sites: LinkedSite[]; nextCursor: string | null }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const safeMessages: Record<string, string> = {
  SITE_LINK_CONFLICT: 'This website already has an assignment that cannot be changed here. Review its existing workspace first.',
  SITE_LINK_CHANGED: 'The assignment changed or was removed. Refresh before trying another change.',
  SITE_NOT_AVAILABLE: 'Only the current website owner can manage this assignment.',
  LINK_PERMISSION_DENIED: 'An active tenant owner or administrator is required.',
  WORKSPACE_ARCHIVED: 'Restore this workspace before adding websites. Removing an existing link is still allowed.',
  TENANT_ACCESS_DENIED: 'Your tenant access changed. Refresh your memberships.',
  SESSION_NOT_ACTIVE: 'Your session is no longer active. Sign in again.',
  UNSAFE_DATABASE_ROLE: 'The runtime database role is not configured safely. Contact the operator.',
  REQUEST_ORIGIN_DENIED: 'The request origin was rejected. Contact the operator.',
  SERVICE_UNAVAILABLE: 'The server could not confirm the result. Refresh to inspect the current assignment.',
  INVALID_RESPONSE: 'The response could not be verified. No successful assignment is assumed.',
  NETWORK_ERROR: 'The connection failed or timed out. A submitted change may still have completed.',
  INVALID_INPUT: 'The website or workspace selection is invalid.',
};
export class SiteLinkClientError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, status = 0) { super(safeMessages[code] ?? safeMessages.SERVICE_UNAVAILABLE); this.name = 'SiteLinkClientError'; this.code = code; this.status = status; }
}
function identifier(value: string): string { if (!uuid(value)) throw new SiteLinkClientError('INVALID_INPUT'); return value.toLowerCase(); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SiteLinkClientError('INVALID_RESPONSE'); return value as Record<string, unknown>; }
/** Explicit tenant/workspace arguments: no global mutable tenant header. */
export function siteLinkClient(baseUrl: string, tenantId: string, workspaceId: string, fetcher: typeof fetch = globalThis.fetch) {
  const tenant = identifier(tenantId), workspace = identifier(workspaceId), base = baseUrl.replace(/\/+$/, '');
  if (base) { const url = new URL(base); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new SiteLinkClientError('INVALID_INPUT'); }
  const prefix = `${base}/api/v1/tenancy/site-links/workspaces/${workspace}`;
  async function request(path: string, method: string, signal: AbortSignal, match?: string) {
    const abort = new AbortController(), cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    const timer = setTimeout(cancel, 12000);
    try {
      const headers = new Headers({ Accept: 'application/json', 'X-ForgeStudio-Tenant': tenant });
      if (method !== 'GET') { headers.set('Content-Type', 'application/json'); headers.set('X-ForgeStudio-Request', 'workspace-v1'); }
      if (match) headers.set('If-Match', `"${identifier(match)}"`);
      const response = await fetcher(prefix + path, { method, headers, credentials: 'include', cache: 'no-store', redirect: 'error', signal: abort.signal, ...(method === 'GET' ? {} : { body: '{}' }) });
      let data: Record<string, unknown>;
      try { data = record(await response.json()); } catch { throw new SiteLinkClientError(response.status === 401 ? 'SESSION_NOT_ACTIVE' : 'INVALID_RESPONSE', response.status); }
      if (!response.ok || data.success !== true) {
        const code = response.status === 401 ? 'SESSION_NOT_ACTIVE' : typeof data.code === 'string' && Object.hasOwn(safeMessages, data.code) ? data.code : 'SERVICE_UNAVAILABLE';
        throw new SiteLinkClientError(code, response.status);
      }
      return data;
    } catch (error) { if (error instanceof SiteLinkClientError) throw error; throw new SiteLinkClientError('NETWORK_ERROR'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }
  return {
    async list(view: 'owned' | 'linked', after: string | null, signal: AbortSignal): Promise<SitePage> {
      const data = await request(`?view=${view}&limit=25${after ? `&after=${identifier(after)}` : ''}`, 'GET', signal);
      if (!Array.isArray(data.sites) || data.sites.length > 25 || (data.nextCursor !== null && !uuid(data.nextCursor))) throw new SiteLinkClientError('INVALID_RESPONSE');
      const sites = data.sites.map(value => {
        const s = record(value);
        if (!uuid(s.id) || typeof s.name !== 'string' || typeof s.slug !== 'string' || typeof s.status !== 'string' ||
          (s.linkId !== null && !uuid(s.linkId)) || (s.linkedAt !== null && (typeof s.linkedAt !== 'string' || !Number.isFinite(Date.parse(s.linkedAt)))) ||
          (view === 'linked' && (!s.linkId || !s.linkedAt))) throw new SiteLinkClientError('INVALID_RESPONSE');
        return { id: s.id.toLowerCase(), name: s.name, slug: s.slug, status: s.status, linkId: s.linkId as string | null, linkedAt: s.linkedAt as string | null };
      });
      const cursor = typeof data.nextCursor === 'string' ? data.nextCursor.toLowerCase() : null;
      if (new Set(sites.map(s => s.id)).size !== sites.length || (cursor && (cursor !== sites.at(-1)?.id || cursor === after))) throw new SiteLinkClientError('INVALID_RESPONSE');
      return { sites, nextCursor: cursor };
    },
    async attach(siteId: string, signal: AbortSignal): Promise<void> {
      const site = identifier(siteId), data = await request(`/sites/${site}`, 'PUT', signal), link = record(data.link);
      if (!uuid(link.id) || link.siteId !== site || link.tenantId !== tenant || link.workspaceId !== workspace || typeof data.created !== 'boolean') throw new SiteLinkClientError('INVALID_RESPONSE');
    },
    async detach(siteId: string, linkId: string, signal: AbortSignal): Promise<void> {
      const data = await request(`/sites/${identifier(siteId)}`, 'DELETE', signal, identifier(linkId));
      if (data.removed !== true) throw new SiteLinkClientError('INVALID_RESPONSE');
    },
  };
}
