/** Request validation only. Site ownership and tenant authority are checked in SQL. */
export class SiteLinkError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = 'SiteLinkError'; this.status = status; this.code = code;
  }
}
export function linkUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new SiteLinkError(400, 'INVALID_INPUT', `${label} must be a UUID`);
  }
  return value.toLowerCase();
}
export type SiteLinkCommand =
  | { kind: 'list'; workspaceId: string; view: 'linked' | 'owned'; after: string | null; limit: number }
  | { kind: 'attach'; workspaceId: string; siteId: string }
  | { kind: 'detach'; workspaceId: string; siteId: string; linkId: string };
export function siteListCommand(workspace: unknown, query: Record<string, unknown>): SiteLinkCommand {
  if (Object.keys(query).some(key => !['view', 'after', 'limit'].includes(key))) throw new SiteLinkError(400, 'INVALID_INPUT', 'Unexpected query parameters');
  const view = query.view ?? 'linked';
  const limit = query.limit === undefined ? 25 : typeof query.limit === 'string' && /^[1-9][0-9]?$/.test(query.limit) ? Number(query.limit) : NaN;
  if ((view !== 'linked' && view !== 'owned') || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new SiteLinkError(400, 'INVALID_INPUT', 'view must be linked or owned; limit must be 1–50');
  return { kind: 'list', workspaceId: linkUuid(workspace, 'workspaceId'), view, limit, after: query.after === undefined ? null : linkUuid(query.after, 'after') };
}
export function siteMutationCommand(kind: 'attach' | 'detach', workspace: unknown, site: unknown, body: unknown, ifMatch?: unknown): SiteLinkCommand {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new SiteLinkError(400, 'INVALID_INPUT', 'An empty JSON object is required; identity fields are not accepted');
  const workspaceId = linkUuid(workspace, 'workspaceId'), siteId = linkUuid(site, 'siteId');
  if (kind === 'attach') return { kind, workspaceId, siteId };
  if (typeof ifMatch !== 'string' || !/^"[^"\\]+"$/.test(ifMatch)) throw new SiteLinkError(428, 'LINK_PRECONDITION_REQUIRED', 'If-Match must contain the quoted current link UUID');
  return { kind, workspaceId, siteId, linkId: linkUuid(ifMatch.slice(1, -1), 'If-Match') };
}
