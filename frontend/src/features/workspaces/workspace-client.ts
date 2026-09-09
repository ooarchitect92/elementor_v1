/** Browser transport for the existing F02 workspace API. No token/role is stored here. */
export type TenantRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'PUBLISHER' | 'VIEWER';
export interface TenantMembership {
  tenantId: string; tenantName: string; userId: string; role: TenantRole; version: string;
}
export interface Workspace {
  id: string; tenantId: string; name: string; slug: string; status: 'ACTIVE' | 'ARCHIVED';
  version: string; createdBy: string; createdAt: string; updatedAt: string;
}
export interface CreateInput { name: string; slug: string }
export interface UpdateInput { name?: string; status?: 'ACTIVE' | 'ARCHIVED'; expectedVersion: string }
export interface WorkspacePage { workspaces: Workspace[]; nextCursor: string | null }
export interface WorkspaceApi {
  memberships(signal?: AbortSignal): Promise<TenantMembership[]>;
  list(tenantId: string, after?: string | null, signal?: AbortSignal): Promise<WorkspacePage>;
  create(tenantId: string, input: CreateInput, key: string, signal?: AbortSignal): Promise<Workspace>;
  update(tenantId: string, id: string, input: UpdateInput, signal?: AbortSignal): Promise<Workspace>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES: readonly string[] = ['OWNER', 'ADMIN', 'EDITOR', 'PUBLISHER', 'VIEWER'];
const MESSAGES: Record<string, string> = {
  SESSION_NOT_ACTIVE: 'Your session is no longer active. Sign in again.',
  TENANT_ACCESS_DENIED: 'Your access to this tenant has changed. Refresh your memberships.',
  NO_ACTIVE_TENANT: 'No active tenant membership is available.',
  WORKSPACE_PERMISSION_DENIED: 'Only an active tenant owner or administrator can manage workspaces.',
  WORKSPACE_VERSION_CONFLICT: 'This workspace changed on the server. Keep a copy of your draft and reload before saving again.',
  WORKSPACE_SLUG_CONFLICT: 'That slug is already reserved, including by archived workspaces. Choose another slug.',
  IDEMPOTENCY_KEY_REUSED: 'This request key belongs to different content. Check the existing workspace before starting a new request.',
  WORKSPACE_NOT_FOUND: 'The workspace is no longer available in this tenant.',
  UNSAFE_DATABASE_ROLE: 'Workspace access is not configured safely. Ask the operator to configure the runtime database role.',
  WORKSPACE_ORIGIN_NOT_CONFIGURED: 'Workspace writes are not configured. Ask the operator to check FRONTEND_URL.',
  REQUEST_ORIGIN_DENIED: 'The server rejected this request origin. Ask the operator to check FRONTEND_URL.',
  INVALID_INPUT: 'Check the workspace name, slug, and version.',
  JSON_REQUIRED: 'The server requires a JSON request.',
  SERVICE_UNAVAILABLE: 'The server could not confirm the operation. Try reading the current state before another change.',
  INVALID_RESPONSE: 'The server response could not be verified. No successful save is being assumed.',
  REQUEST_FAILED: 'The request could not be completed.',
  NETWORK_ERROR: 'The connection failed or timed out. The server may still have received the request.',
  REQUEST_CANCELLED: 'The request was interrupted. This does not cancel a change already received by the server.',
};
export class WorkspaceClientError extends Error {
  readonly code: string; readonly status: number; readonly uncertain: boolean; readonly traceId: string | null;
  constructor(code: string, status = 0, uncertain = false, traceId: string | null = null) {
    super(MESSAGES[code] ?? MESSAGES.REQUEST_FAILED); this.name = 'WorkspaceClientError';
    this.code = code; this.status = status; this.uncertain = uncertain; this.traceId = traceId;
  }
}
export function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function id(value: string): string { if (!isUuid(value)) throw new WorkspaceClientError('INVALID_INPUT', 400); return value.toLowerCase(); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceClientError('INVALID_RESPONSE', 502);
  return value as Record<string, unknown>;
}
function version(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
function name(value: unknown, max = 120): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function slug(value: unknown): value is string { return typeof value === 'string' && value.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value); }
export function validateCreate(input: CreateInput): CreateInput {
  if (!name(input.name) || !slug(input.slug)) throw new WorkspaceClientError('INVALID_INPUT', 400);
  return { name: input.name.trim(), slug: input.slug };
}
export function canManage(role: TenantRole | undefined): boolean { return role === 'OWNER' || role === 'ADMIN'; }
export function requestKey(): string {
  // getRandomValues is available even where randomUUID requires a secure context.
  const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function readWorkspace(value: unknown, tenantId: string): Workspace {
  const row = object(value);
  if (!isUuid(row.id) || !isUuid(row.tenantId) || row.tenantId.toLowerCase() !== tenantId || !isUuid(row.createdBy) ||
      !name(row.name) || !slug(row.slug) || !version(row.version) || !['ACTIVE', 'ARCHIVED'].includes(String(row.status)) ||
      typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) ||
      typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) throw new WorkspaceClientError('INVALID_RESPONSE', 502);
  return { id: row.id.toLowerCase(), tenantId, name: row.name, slug: row.slug, status: row.status as Workspace['status'],
    version: row.version, createdBy: row.createdBy.toLowerCase(), createdAt: row.createdAt, updatedAt: row.updatedAt };
}
export function createWorkspaceClient(baseUrl: string, userId: string, fetcher: typeof fetch = globalThis.fetch, timeoutMs = 15000): WorkspaceApi {
  const verifiedUser = id(userId);
  const base = baseUrl.replace(/\/+$/, '');
  if (base) {
    const parsed = new URL(base);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid workspace API base URL');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid request timeout');
  async function request<T>(path: string, method: string, tenant: string | null, body: unknown, key: string | null,
    signal: AbortSignal | undefined, parse: (body: Record<string, unknown>) => T): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(cancel, timeoutMs);
    const mutation = method !== 'GET';
    const headers = new Headers({ Accept: 'application/json' });
    if (tenant) headers.set('X-ForgeStudio-Tenant', id(tenant));
    if (mutation) { headers.set('Content-Type', 'application/json'); headers.set('X-ForgeStudio-Request', 'workspace-v1'); }
    if (key) headers.set('Idempotency-Key', id(key));
    try {
      const response = await fetcher(`${base}/api/v1/tenancy${path}`, {
        method, credentials: 'include', cache: 'no-store', redirect: 'error', headers, signal: controller.signal,
        ...(mutation ? { body: JSON.stringify(body) } : {}),
      });
      let payload: Record<string, unknown>;
      try { payload = object(await response.json()); } catch {
        if (!response.ok && response.status === 401) throw new WorkspaceClientError('SESSION_NOT_ACTIVE', 401);
        throw new WorkspaceClientError('INVALID_RESPONSE', response.status, mutation);
      }
      if (!response.ok || payload.success !== true) {
        const code = response.status === 401 ? 'SESSION_NOT_ACTIVE' : typeof payload.code === 'string' && Object.hasOwn(MESSAGES, payload.code)
          ? payload.code : response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'REQUEST_FAILED';
        throw new WorkspaceClientError(code, response.status, mutation && (response.status >= 500 || response.ok), isUuid(payload.traceId) ? payload.traceId : null);
      }
      try { return parse(payload); } catch { throw new WorkspaceClientError('INVALID_RESPONSE', response.status, mutation); }
    } catch (error) {
      if (error instanceof WorkspaceClientError) throw error;
      throw new WorkspaceClientError(signal?.aborted ? 'REQUEST_CANCELLED' : 'NETWORK_ERROR', 0, mutation);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  return {
    memberships(signal) {
      return request('/memberships', 'GET', null, null, null, signal, payload => {
        if (!Array.isArray(payload.tenants)) throw new WorkspaceClientError('INVALID_RESPONSE');
        const tenants = payload.tenants.map(value => {
          const row = object(value);
          if (!isUuid(row.tenantId) || !isUuid(row.userId) || row.userId.toLowerCase() !== verifiedUser ||
              !name(row.tenantName, 200) || row.membershipStatus !== 'ACTIVE' || row.tenantStatus !== 'ACTIVE' ||
              !ROLES.includes(String(row.role)) || !version(row.version)) throw new WorkspaceClientError('INVALID_RESPONSE');
          return { tenantId: row.tenantId.toLowerCase(), tenantName: row.tenantName, userId: verifiedUser, role: row.role as TenantRole, version: row.version };
        });
        if (new Set(tenants.map(t => t.tenantId)).size !== tenants.length) throw new WorkspaceClientError('INVALID_RESPONSE');
        return tenants;
      });
    },
    list(tenantId, after = null, signal) {
      const tenant = id(tenantId);
      return request(`/workspaces?limit=50${after ? `&after=${id(after)}` : ''}`, 'GET', tenant, null, null, signal, payload => {
        if (!Array.isArray(payload.workspaces) || payload.workspaces.length > 50 || (payload.nextCursor !== null && !isUuid(payload.nextCursor))) throw new WorkspaceClientError('INVALID_RESPONSE');
        const workspaces = payload.workspaces.map(row => readWorkspace(row, tenant));
        const cursor = typeof payload.nextCursor === 'string' ? payload.nextCursor.toLowerCase() : null;
        if (new Set(workspaces.map(w => w.id)).size !== workspaces.length ||
            (cursor && (cursor !== workspaces.at(-1)?.id || cursor === after))) throw new WorkspaceClientError('INVALID_RESPONSE');
        return { workspaces, nextCursor: cursor };
      });
    },
    create(tenantId, input, key, signal) {
      const tenant = id(tenantId);
      return request('/workspaces', 'POST', tenant, validateCreate(input), id(key), signal, payload => readWorkspace(payload.workspace, tenant));
    },
    update(tenantId, workspaceId, input, signal) {
      const tenant = id(tenantId); const target = id(workspaceId);
      if (!version(input.expectedVersion) || BigInt(input.expectedVersion) >= 9223372036854775807n ||
          (input.name === undefined && input.status === undefined) || (input.name !== undefined && !name(input.name)) ||
          (input.status !== undefined && !['ACTIVE', 'ARCHIVED'].includes(input.status))) throw new WorkspaceClientError('INVALID_INPUT', 400);
      const body = { expectedVersion: input.expectedVersion, ...(input.name !== undefined ? { name: input.name.trim() } : {}), ...(input.status !== undefined ? { status: input.status } : {}) };
      return request(`/workspaces/${target}`, 'PATCH', tenant, body, null, signal, payload => {
        const row = readWorkspace(payload.workspace, tenant);
        if (row.id !== target) throw new WorkspaceClientError('INVALID_RESPONSE');
        return row;
      });
    },
  };
}
