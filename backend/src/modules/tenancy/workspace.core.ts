/** Workspace operations execute on ONE caller-owned PostgreSQL transaction.
 * No connections, network calls, environment reads or import-time side effects.
 */
export interface WorkspaceTx {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}
export interface WorkspaceActor { userId: string; sessionId: string; tenantId: string; traceId: string }
export interface WorkspaceRow {
  id: string; tenant_id: string; name: string; slug: string; status: 'ACTIVE' | 'ARCHIVED';
  version: bigint; created_by: string; created_at: Date; updated_at: Date;
  create_key: string; create_name: string; create_slug: string;
}
export type WorkspaceCommand =
  | { kind: 'list'; after: string | null; limit: number }
  | { kind: 'get'; id: string }
  | { kind: 'create'; id: string; key: string; name: string; slug: string }
  | { kind: 'update'; id: string; expectedVersion: string; name: string | null; status: 'ACTIVE' | 'ARCHIVED' | null };
export class WorkspaceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = 'WorkspaceError'; this.status = status; this.code = code;
  }
}
function fail(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message); }
export function workspaceUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail(400, 'INVALID_INPUT', `${field} must be a UUID`);
  }
  return value.toLowerCase();
}
function bodyObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_INPUT', 'A JSON object is required');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_INPUT', 'Unexpected request fields');
  return body;
}
function workspaceName(value: unknown): string {
  if (typeof value !== 'string') fail(400, 'INVALID_INPUT', 'name is required');
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) fail(400, 'INVALID_INPUT', 'name must be 1–120 printable characters');
  return name;
}
export function createWorkspaceCommand(body: unknown, key: unknown, id: string): WorkspaceCommand {
  const input = bodyObject(body, ['name', 'slug']);
  if (typeof input.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 63) {
    fail(400, 'INVALID_INPUT', 'slug must be 1–63 lowercase letters, digits or internal hyphens');
  }
  return { kind: 'create', id: workspaceUuid(id, 'id'), key: workspaceUuid(key, 'Idempotency-Key'), name: workspaceName(input.name), slug: input.slug };
}
export function updateWorkspaceCommand(id: unknown, body: unknown): WorkspaceCommand {
  const input = bodyObject(body, ['name', 'status', 'expectedVersion']);
  if (typeof input.expectedVersion !== 'string' || !/^[1-9][0-9]{0,18}$/.test(input.expectedVersion) || BigInt(input.expectedVersion) >= 9223372036854775807n) {
    fail(400, 'INVALID_INPUT', 'expectedVersion must be a positive decimal version string');
  }
  if (!Object.hasOwn(input, 'name') && !Object.hasOwn(input, 'status')) fail(400, 'INVALID_INPUT', 'name or status is required');
  if (Object.hasOwn(input, 'status') && input.status !== 'ACTIVE' && input.status !== 'ARCHIVED') fail(400, 'INVALID_INPUT', 'status must be ACTIVE or ARCHIVED');
  return {
    kind: 'update', id: workspaceUuid(id, 'workspaceId'), expectedVersion: input.expectedVersion,
    name: Object.hasOwn(input, 'name') ? workspaceName(input.name) : null,
    status: Object.hasOwn(input, 'status') ? input.status as 'ACTIVE' | 'ARCHIVED' : null,
  };
}
export function listWorkspaceCommand(query: Record<string, unknown>): WorkspaceCommand {
  if (Object.keys(query).some(key => !['after', 'limit'].includes(key))) fail(400, 'INVALID_INPUT', 'Unexpected query parameters');
  const limit = query.limit === undefined ? 50 : typeof query.limit === 'string' && /^[1-9][0-9]{0,2}$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'INVALID_INPUT', 'limit must be between 1 and 100');
  return { kind: 'list', after: query.after === undefined ? null : workspaceUuid(query.after, 'after'), limit };
}
/** Browser CSRF defense: exact configured Origin AND a non-simple custom header.
 * This header is not an authentication secret. Scripts still require a session.
 */
export function assertWorkspaceMutation(origin: unknown, marker: unknown, contentType: unknown, trustedOrigin: string | undefined, production: boolean): void {
  let configured: URL;
  try { configured = new URL(trustedOrigin ?? ''); } catch { return fail(503, 'WORKSPACE_ORIGIN_NOT_CONFIGURED', 'Workspace writes are not configured'); }
  if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash || (production && configured.protocol !== 'https:')) {
    fail(503, 'WORKSPACE_ORIGIN_NOT_CONFIGURED', 'Workspace writes are not configured');
  }
  if (origin !== configured.origin || marker !== 'workspace-v1') fail(403, 'REQUEST_ORIGIN_DENIED', 'Trusted Origin and X-ForgeStudio-Request are required');
  if (typeof contentType !== 'string' || contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') fail(415, 'JSON_REQUIRED', 'Content-Type application/json is required');
}
export function serializeWorkspace(row: WorkspaceRow, creationReceipt = false) {
  return {
    id: row.id, tenantId: row.tenant_id, name: creationReceipt ? row.create_name : row.name,
    slug: creationReceipt ? row.create_slug : row.slug, status: creationReceipt ? 'ACTIVE' : row.status,
    version: creationReceipt ? '1' : row.version.toString(), createdBy: row.created_by,
    createdAt: row.created_at.toISOString(), updatedAt: (creationReceipt ? row.created_at : row.updated_at).toISOString(),
  };
}
export interface WorkspaceResult {
  workspace?: ReturnType<typeof serializeWorkspace>;
  workspaces?: ReturnType<typeof serializeWorkspace>[];
  nextCursor?: string | null;
  replayed?: boolean;
}
export async function runWorkspaceCommand(tx: WorkspaceTx, rawActor: WorkspaceActor, command: WorkspaceCommand, auditId: string): Promise<WorkspaceResult> {
  const actor = {
    userId: workspaceUuid(rawActor.userId, 'userId'), sessionId: workspaceUuid(rawActor.sessionId, 'sessionId'),
    tenantId: workspaceUuid(rawActor.tenantId, 'tenantId'), traceId: workspaceUuid(rawActor.traceId, 'traceId'),
  };
  workspaceUuid(auditId, 'auditId');
  // Overwrite both scopes even when a pool connection was used for another tenant.
  await tx.$queryRaw`SELECT set_config('app.user_id', ${actor.userId}, true), set_config('app.tenant_id', ${actor.tenantId}, true), set_config('lock_timeout', '2000ms', true), set_config('statement_timeout', '4000ms', true)`;
  const dbRoles = await tx.$queryRaw<{ unsafe: boolean }[]>`
    SELECT (r.rolsuper OR r.rolbypassrls OR r.oid = c.relowner) AS unsafe
    FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
    WHERE r.rolname = current_user AND c.oid = 'platform.workspaces'::regclass
  `;
  if (dbRoles.length !== 1 || dbRoles[0]?.unsafe !== false) fail(503, 'UNSAFE_DATABASE_ROLE', 'Workspace operations require a non-owner, non-bypass database role');
  // Authority is refreshed and locked inside the same transaction as the mutation.
  // Concurrent revocation/suspension waits for an already-authorized operation;
  // a revocation committed first prevents that operation from starting.
  const sessions = await tx.$queryRaw<{ id: string }[]>`
    SELECT s.id FROM public.sessions s JOIN public.users u ON u.id = s."userId"
    WHERE s.id = ${actor.sessionId}::uuid AND u.id = ${actor.userId}::uuid
      AND u.status = 'ACTIVE' AND s."revokedAt" IS NULL
      AND s."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    FOR SHARE OF u, s
  `;
  if (sessions.length !== 1) fail(401, 'SESSION_NOT_ACTIVE', 'An active session and account are required');
  const memberships = await tx.$queryRaw<{ role: string }[]>`
    SELECT m.role FROM platform.memberships m JOIN platform.tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = ${actor.tenantId}::uuid AND m.user_id = ${actor.userId}::uuid
      AND m.status = 'ACTIVE' AND t.status = 'ACTIVE'
    FOR SHARE OF t, m
  `;
  const role = memberships[0]?.role;
  const canRead = role !== undefined && ['OWNER', 'ADMIN', 'EDITOR', 'PUBLISHER', 'VIEWER'].includes(role);
  if (memberships.length !== 1 || !canRead) fail(403, 'TENANT_ACCESS_DENIED', 'No active tenant membership is available');
  if ((command.kind === 'create' || command.kind === 'update') && role !== 'OWNER' && role !== 'ADMIN') fail(403, 'WORKSPACE_PERMISSION_DENIED', 'Workspace management requires OWNER or ADMIN');
  if (command.kind === 'list') {
    const rows = await tx.$queryRaw<WorkspaceRow[]>`
      SELECT * FROM platform.workspaces WHERE tenant_id = ${actor.tenantId}::uuid
        AND (${command.after}::uuid IS NULL OR id > ${command.after}::uuid)
      ORDER BY id ASC LIMIT ${command.limit + 1}
    `;
    const page = rows.slice(0, command.limit);
    return { workspaces: page.map(row => serializeWorkspace(row)), nextCursor: rows.length > command.limit ? page[page.length - 1]?.id ?? null : null };
  }
  if (command.kind === 'get') {
    const rows = await tx.$queryRaw<WorkspaceRow[]>`SELECT * FROM platform.workspaces WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${workspaceUuid(command.id, 'workspaceId')}::uuid`;
    if (!rows[0]) fail(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
    return { workspace: serializeWorkspace(rows[0]) };
  }
  let row: WorkspaceRow;
  if (command.kind === 'create') {
    const inserted = await tx.$queryRaw<WorkspaceRow[]>`
      INSERT INTO platform.workspaces (tenant_id, id, name, slug, created_by, create_key, create_name, create_slug)
      VALUES (${actor.tenantId}::uuid, ${command.id}::uuid, ${command.name}, ${command.slug}, ${actor.userId}::uuid, ${command.key}::uuid, ${command.name}, ${command.slug})
      ON CONFLICT DO NOTHING RETURNING *
    `;
    if (!inserted[0]) {
      const receipts = await tx.$queryRaw<WorkspaceRow[]>`SELECT * FROM platform.workspaces WHERE tenant_id = ${actor.tenantId}::uuid AND create_key = ${command.key}::uuid`;
      const receipt = receipts[0];
      if (!receipt) fail(409, 'WORKSPACE_SLUG_CONFLICT', 'Workspace slug is already in use');
      if (receipt.create_name !== command.name || receipt.create_slug !== command.slug) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
      return { workspace: serializeWorkspace(receipt, true), replayed: true };
    }
    row = inserted[0];
  } else {
    const updated = await tx.$queryRaw<WorkspaceRow[]>`
      UPDATE platform.workspaces SET name = COALESCE(${command.name}::text, name),
        status = COALESCE(${command.status}::text, status), version = version + 1, updated_at = clock_timestamp()
      WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${command.id}::uuid AND version = ${command.expectedVersion}::bigint
      RETURNING *
    `;
    if (!updated[0]) {
      const existing = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM platform.workspaces WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${command.id}::uuid`;
      if (!existing[0]) fail(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
      fail(409, 'WORKSPACE_VERSION_CONFLICT', 'Workspace changed; reload before retrying');
    }
    row = updated[0];
  }
  const action = command.kind === 'create' ? 'workspace.created' : 'workspace.updated';
  await tx.$executeRaw`
    INSERT INTO platform.audit_events (tenant_id, id, actor_id, action, resource_id, trace_id)
    VALUES (${actor.tenantId}::uuid, ${auditId}::uuid, ${actor.userId}::uuid, ${action}, ${row.id}::uuid, ${actor.traceId}::uuid)
  `;
  return { workspace: serializeWorkspace(row, command.kind === 'create'), ...(command.kind === 'create' ? { replayed: false } : {}) };
}
