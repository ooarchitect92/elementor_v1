import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient, validateCreate, requestKey, isUuid, canManage } from '../../.foundation/workspace-ui/workspace-client.js';
const U = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';
const K = '44444444-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';
const membership = { tenantId: T, tenantName: 'Tenant A', userId: U, role: 'OWNER', version: '1', tenantStatus: 'ACTIVE', membershipStatus: 'ACTIVE' };
const workspace = { id: W, tenantId: T, name: 'Marketing', slug: 'marketing', status: 'ACTIVE', version: '1', createdBy: U, createdAt: '2026-09-09T10:00:00.000Z', updatedAt: '2026-09-09T10:00:00.000Z' };
function fixture(body, status = 200) {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return Response.json(body, { status }); };
  return { api: createWorkspaceClient('https://api.example.test', U, fetcher), calls };
}
test('membership discovery checks identity and returns only supported DTO fields', async () => {
  const { api, calls } = fixture({ success: true, tenants: [{ ...membership, secret: 'not-returned' }] });
  const rows = await api.memberships();
  assert.equal(rows.length, 1); assert.equal(rows[0].userId, U); assert.equal(rows[0].secret, undefined);
  assert.equal(calls[0].options.headers.has('X-ForgeStudio-Tenant'), false);
});
for (const change of [{ userId: other }, { role: 'SUPER_ADMIN' }, { tenantStatus: 'SUSPENDED' }, { membershipStatus: 'SUSPENDED' }, { version: 1 }]) {
  test(`invalid membership is rejected: ${JSON.stringify(change)}`, async () => {
    await assert.rejects(fixture({ success: true, tenants: [{ ...membership, ...change }] }).api.memberships(), { code: 'INVALID_RESPONSE' });
  });
}
test('duplicate membership results fail closed rather than choosing a tenant', async () => {
  await assert.rejects(fixture({ success: true, tenants: [membership, membership] }).api.memberships(), { code: 'INVALID_RESPONSE' });
});
test('list requests use verified selector, cookies, no-store and no redirect following', async () => {
  const { api, calls } = fixture({ success: true, workspaces: [workspace], nextCursor: null });
  const result = await api.list(T);
  assert.equal(result.workspaces[0].id, W);
  assert.equal(calls[0].url, 'https://api.example.test/api/v1/tenancy/workspaces?limit=50');
  const options = calls[0].options;
  assert.equal(options.credentials, 'include'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers.get('X-ForgeStudio-Tenant'), T);
  assert.equal(options.headers.has('Authorization'), false);
});
test('cross-tenant response and repeated/invalid cursors are rejected', async () => {
  await assert.rejects(fixture({ success: true, workspaces: [{ ...workspace, tenantId: other }], nextCursor: null }).api.list(T), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture({ success: true, workspaces: [workspace], nextCursor: other }).api.list(T), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture({ success: true, workspaces: [workspace], nextCursor: W }).api.list(T, W), { code: 'INVALID_RESPONSE' });
});
test('create sends exact CSRF/idempotency contract without body authority fields', async () => {
  const { api, calls } = fixture({ success: true, workspace }, 201);
  await api.create(T, { name: ' Marketing ', slug: 'marketing', tenantId: other, role: 'OWNER' }, K);
  const options = calls[0].options;
  assert.deepEqual(JSON.parse(options.body), { name: 'Marketing', slug: 'marketing' });
  assert.equal(options.headers.get('Idempotency-Key'), K);
  assert.equal(options.headers.get('X-ForgeStudio-Request'), 'workspace-v1');
  assert.equal(options.headers.get('Content-Type'), 'application/json');
  assert.equal(options.headers.has('Origin'), false); // browser supplies Origin
});
test('patch preserves large version strings and excludes unexpected fields', async () => {
  const { api, calls } = fixture({ success: true, workspace: { ...workspace, version: '9223372036854775807' } });
  await api.update(T, W, { name: ' Renamed ', expectedVersion: '9223372036854775806', tenantId: other });
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'Renamed', expectedVersion: '9223372036854775806' });
});
test('a different workspace returned by PATCH is not acknowledged', async () => {
  await assert.rejects(fixture({ success: true, workspace: { ...workspace, id: other } }).api.update(T, W, { name: 'New', expectedVersion: '1' }), { code: 'INVALID_RESPONSE', uncertain: true });
});
test('malformed successful mutation response is an uncertain outcome', async () => {
  await assert.rejects(fixture({ success: true, workspace: {} }, 201).api.create(T, { name: 'M', slug: 'm' }, K), { code: 'INVALID_RESPONSE', uncertain: true });
});
test('non-JSON proxy responses do not leak server output or imply success', async () => {
  const api = createWorkspaceClient('https://api.example.test', U, async () => new Response('<html>password=secret</html>', { status: 502 }));
  await assert.rejects(api.create(T, { name: 'M', slug: 'm' }, K), error => error.code === 'INVALID_RESPONSE' && error.uncertain && !error.message.includes('secret'));
});
test('known conflicts retain safe support trace and omit arbitrary backend text', async () => {
  const { api } = fixture({ success: false, code: 'WORKSPACE_VERSION_CONFLICT', message: 'SQL password=secret', traceId: K }, 409);
  await assert.rejects(api.update(T, W, { name: 'M', expectedVersion: '1' }), error => error.code === 'WORKSPACE_VERSION_CONFLICT' && !error.uncertain && error.traceId === K && !error.message.includes('secret'));
});
test('unknown backend errors are sanitized and mutation failures remain uncertain', async () => {
  const { api } = fixture({ success: false, code: 'SQL_PASSWORD_secret', message: 'internal secret', traceId: 'not-a-uuid' }, 503);
  await assert.rejects(api.create(T, { name: 'M', slug: 'm' }, K), error => error.code === 'SERVICE_UNAVAILABLE' && error.uncertain && error.traceId === null && !error.message.includes('secret'));
});
test('HTTP 200 with success=false is never a saved result', async () => {
  await assert.rejects(fixture({ success: false }).api.create(T, { name: 'M', slug: 'm' }, K), { uncertain: true });
});
test('authentication expiry is recognized even for non-JSON responses', async () => {
  const api = createWorkspaceClient('', U, async () => new Response('Unauthorized', { status: 401 }));
  await assert.rejects(api.memberships(), { code: 'SESSION_NOT_ACTIVE', status: 401 });
});
test('timeouts are bounded and never automatically retry a mutation', async () => {
  let calls = 0;
  const api = createWorkspaceClient('', U, (_url, options) => { calls++; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })); }, 10);
  await assert.rejects(api.create(T, { name: 'M', slug: 'm' }, K), { code: 'NETWORK_ERROR', uncertain: true });
  assert.equal(calls, 1);
});
test('external cancellation does not claim the server operation was cancelled', async () => {
  const controller = new AbortController();
  const api = createWorkspaceClient('', U, (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })));
  const result = api.create(T, { name: 'M', slug: 'm' }, K, controller.signal); controller.abort();
  await assert.rejects(result, { code: 'REQUEST_CANCELLED', uncertain: true });
});
test('input validation matches backend name/slug boundaries', () => {
  assert.deepEqual(validateCreate({ name: ' Marketing ', slug: 'marketing-1' }), { name: 'Marketing', slug: 'marketing-1' });
  for (const value of [{ name: '', slug: 'a' }, { name: 'a\n', slug: 'a' }, { name: 'a'.repeat(121), slug: 'a' }, { name: 'a', slug: 'A' }, { name: 'a', slug: '-a' }, { name: 'a', slug: 'a'.repeat(64) }]) assert.throws(() => validateCreate(value));
});
test('request keys are UUIDs generated without role-based authority', () => {
  const keys = new Set(Array.from({ length: 20 }, requestKey));
  assert.equal(keys.size, 20); assert.ok([...keys].every(isUuid));
  assert.equal(canManage('OWNER'), true); assert.equal(canManage('ADMIN'), true); assert.equal(canManage('VIEWER'), false); assert.equal(canManage('SUPER_ADMIN'), false);
});
test('unsafe API URLs and invalid user identities are refused', () => {
  assert.throws(() => createWorkspaceClient('https://user:password@example.test', U));
  assert.throws(() => createWorkspaceClient('file:///tmp/', U));
  assert.throws(() => createWorkspaceClient('https://example.test?token=secret', U));
  assert.throws(() => createWorkspaceClient('', 'not-an-id'));
});
