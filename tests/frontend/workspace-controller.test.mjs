import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceController, WorkspaceRecovery } from '../../.foundation/workspace-ui/workspace-controller.js';
import { WorkspaceClientError } from '../../.foundation/workspace-ui/workspace-client.js';
const U = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const W = '44444444-4444-4444-8444-444444444444';
const K = '55555555-5555-4555-8555-555555555555';
const member = (tenantId = A, role = 'OWNER') => ({ userId: U, tenantId, tenantName: tenantId === A ? 'Tenant A' : 'Tenant B', role, version: '1' });
const workspace = (tenantId = A, changes = {}) => ({ id: W, tenantId, name: 'Original', slug: 'original', status: 'ACTIVE', version: '1', createdBy: U, createdAt: '2026-09-09T10:00:00Z', updatedAt: '2026-09-09T10:00:00Z', ...changes });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function storage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
function setup(overrides = {}, store = storage()) {
  const calls = [];
  const api = { memberships: async () => [member()], list: async tenant => ({ workspaces: [workspace(tenant)], nextCursor: null }),
    create: async (...args) => { calls.push(args); return workspace(); }, update: async (...args) => { calls.push(args); return workspace(A, { version: '2' }); }, ...overrides };
  const recovery = new WorkspaceRecovery(U, () => store);
  const controller = new WorkspaceController(api, recovery, () => K);
  return { controller, recovery, api, calls, store };
}
test('one active membership is selected; multiple memberships require explicit choice', async () => {
  const one = setup(); await one.controller.start(); assert.equal(one.controller.getSnapshot().tenantId, A);
  const multi = setup({ memberships: async () => [member(), member(B)] }); await multi.controller.start();
  assert.equal(multi.controller.getSnapshot().tenantId, ''); assert.deepEqual(multi.controller.getSnapshot().workspaces, []);
  await multi.controller.selectTenant('forged'); assert.equal(multi.controller.getSnapshot().tenantId, '');
  await multi.controller.selectTenant(B); assert.equal(multi.controller.getSnapshot().workspaces[0].tenantId, B);
});
test('no memberships is a real empty state, not automatically provisioned', async () => {
  const { controller } = setup({ memberships: async () => [] }); await controller.start();
  assert.equal(controller.getSnapshot().phase, 'no-tenants'); assert.equal(await controller.create({ name: 'a', slug: 'a' }), false);
});
test('tenant switch clears data immediately and ignores late previous-tenant responses', async () => {
  const slow = deferred();
  const { controller } = setup({ memberships: async () => [member(), member(B)], list: async tenant => tenant === A ? slow.promise : { workspaces: [workspace(B)], nextCursor: null } });
  await controller.start(); const first = controller.selectTenant(A); await controller.selectTenant(B);
  assert.equal(controller.getSnapshot().workspaces[0].tenantId, B);
  slow.resolve({ workspaces: [workspace(A)], nextCursor: null }); await first;
  assert.equal(controller.getSnapshot().tenantId, B); assert.equal(controller.getSnapshot().workspaces[0].tenantId, B);
});
test('latest refresh wins even when aborted transport ignores cancellation', async () => {
  const slow = deferred(); let count = 0;
  const { controller } = setup({ list: async () => ++count === 2 ? slow.promise : { workspaces: [workspace(A, { name: `Result ${count}` })], nextCursor: null } });
  await controller.start(); const old = controller.loadPage(); await controller.loadPage();
  slow.resolve({ workspaces: [workspace(A, { name: 'Old' })], nextCursor: null }); await old;
  assert.equal(controller.getSnapshot().workspaces[0].name, 'Result 3');
});
test('StrictMode restart and stop fence old membership results', async () => {
  const slow = deferred(); let count = 0;
  const { controller } = setup({ memberships: async () => ++count === 1 ? slow.promise : [member(B)] });
  const first = controller.start(); controller.stop(); await controller.start(); slow.resolve([member(A)]); await first;
  assert.equal(controller.getSnapshot().tenantId, B);
});
test('permission loss clears previously visible tenant data and roles', async () => {
  const { controller, api } = setup(); await controller.start();
  api.list = async () => { throw new WorkspaceClientError('TENANT_ACCESS_DENIED', 403); };
  await controller.loadPage(); const state = controller.getSnapshot();
  assert.equal(state.phase, 'error'); assert.deepEqual(state.workspaces, []); assert.deepEqual(state.memberships, []); assert.equal(state.tenantId, '');
});
test('session expiry clears workspace data rather than rendering a stale authenticated screen', async () => {
  const { controller, api } = setup(); await controller.start();
  api.list = async () => { throw new WorkspaceClientError('SESSION_NOT_ACTIVE', 401); }; await controller.loadPage();
  assert.equal(controller.getSnapshot().phase, 'auth-required'); assert.deepEqual(controller.getSnapshot().workspaces, []);
});
test('list failure is distinct from an empty success', async () => {
  const { controller } = setup({ list: async () => { throw new WorkspaceClientError('NETWORK_ERROR'); } }); await controller.start();
  assert.equal(controller.getSnapshot().listError.code, 'NETWORK_ERROR'); assert.equal(controller.getSnapshot().loadingList, false);
});
test('read-only memberships cannot create or change workspaces', async () => {
  const { controller, calls } = setup({ memberships: async () => [member(A, 'VIEWER')] }); await controller.start();
  assert.equal(await controller.create({ name: 'a', slug: 'a' }), false);
  assert.equal(await controller.update(workspace(), { name: 'x', expectedVersion: '1' }), false); assert.equal(calls.length, 0);
});
test('pending creation is persisted before the first POST and retries keep exact key/payload', async () => {
  const { controller, api, recovery } = setup(); await controller.start(); const sent = [];
  api.create = async (...args) => { sent.push(args); assert.equal(recovery.read(A).key, K); throw new WorkspaceClientError('NETWORK_ERROR', 0, true); };
  await controller.create({ name: ' Original ', slug: 'original' }); await controller.retryCreate();
  assert.equal(sent.length, 2); assert.deepEqual(sent[0].slice(0, 3), sent[1].slice(0, 3));
  assert.equal(await controller.create({ name: 'different', slug: 'different' }), false); assert.equal(sent.length, 2);
});
test('reloading the page recovers the same uncertain request and refreshes current state, not the original receipt', async () => {
  const first = setup(); await first.controller.start(); first.api.create = async () => { throw new WorkspaceClientError('NETWORK_ERROR', 0, true); };
  await first.controller.create({ name: 'Original', slug: 'original' }); first.controller.stop();
  const second = setup({ list: async () => ({ workspaces: [workspace(A, { name: 'Renamed', status: 'ARCHIVED', version: '8' })], nextCursor: null }) }, first.store);
  await second.controller.start(); assert.equal(second.controller.getSnapshot().pending.key, K);
  await second.controller.retryCreate();
  assert.equal(second.calls[0][2], K); assert.equal(second.controller.getSnapshot().pending, null);
  assert.equal(second.controller.getSnapshot().workspaces[0].name, 'Renamed'); assert.equal(second.controller.getSnapshot().workspaces[0].version, '8');
});
test('storage failure prevents sending an unrecoverable creation', async () => {
  const store = storage(); store.setItem = () => { throw new Error('quota'); };
  const { controller, calls } = setup({}, store); await controller.start(); await controller.create({ name: 'a', slug: 'a' });
  assert.equal(calls.length, 0); assert.equal(controller.getSnapshot().recoveryError.code, 'RECOVERY_STORAGE_UNAVAILABLE');
});
test('corrupt recovery records are not erased or used as request authority', async () => {
  const { controller, store } = setup(); store.setItem(`forgestudio.workspace-create.v1:${U}:${A}`, '{bad'); await controller.start();
  assert.equal(controller.getSnapshot().recoveryError.code, 'RECOVERY_DATA_INVALID');
  assert.equal(await controller.create({ name: 'a', slug: 'a' }), false); assert.equal(store.data.size, 1);
});
test('recovery keys are isolated by user and tenant', () => {
  const store = storage(); const first = new WorkspaceRecovery(U, () => store); const second = new WorkspaceRecovery(B, () => store);
  first.write(A, { name: 'a', slug: 'a' }, K);
  assert.equal(first.read(B), null); assert.equal(second.read(A), null); assert.equal(first.read(A).key, K);
});
test('simultaneous clicks send one mutation and cannot switch tenant while it is in flight', async () => {
  const slow = deferred(); let sent = 0;
  const { controller } = setup({ memberships: async () => [member(), member(B)], create: async () => { sent++; return slow.promise; } });
  await controller.start(); await controller.selectTenant(A);
  const creating = controller.create({ name: 'a', slug: 'a' }); await controller.retryCreate(); await controller.selectTenant(B);
  assert.equal(sent, 1); assert.equal(controller.getSnapshot().tenantId, A);
  slow.resolve(workspace()); await creating;
});
test('creation receipt is retained if the page unmounts before completion', async () => {
  const slow = deferred(); const { controller, recovery } = setup({ create: async () => slow.promise }); await controller.start();
  const creating = controller.create({ name: 'a', slug: 'a' }); controller.stop(); slow.resolve(workspace()); await creating;
  assert.equal(recovery.read(A).key, K);
});
test('update uses the editor snapshot version, not a refreshed row or caller override', async () => {
  const { controller, calls } = setup({ list: async () => ({ workspaces: [workspace(A, { version: '4' })], nextCursor: null }) }); await controller.start();
  await controller.update(workspace(A, { version: '2' }), { name: 'x', expectedVersion: '999' });
  assert.equal(calls[0][2].expectedVersion, '2');
});
test('conflict and uncertain PATCH outcomes block repeated writes until explicit reload', async () => {
  for (const error of [new WorkspaceClientError('WORKSPACE_VERSION_CONFLICT', 409), new WorkspaceClientError('NETWORK_ERROR', 0, true)]) {
    let count = 0; const { controller } = setup({ update: async () => { count++; throw error; } }); await controller.start();
    await controller.update(workspace(), { name: 'x', expectedVersion: '1' });
    await controller.update(workspace(), { name: 'x', expectedVersion: '1' }); assert.equal(count, 1);
    await controller.discardDraftAndReload(); await controller.update(workspace(), { name: 'x', expectedVersion: '1' }); assert.equal(count, 2);
  }
});
test('foreign workspace update is rejected before transport', async () => {
  const { controller, calls } = setup(); await controller.start();
  assert.equal(await controller.update(workspace(B), { name: 'x', expectedVersion: '1' }), false); assert.equal(calls.length, 0);
});
test('pagination merges only consistent rows and retains an explicit error on duplicates', async () => {
  let count = 0; const { controller } = setup({ list: async () => ({ workspaces: [workspace()], nextCursor: ++count === 1 ? W : null }) }); await controller.start();
  await controller.loadPage(W); assert.equal(controller.getSnapshot().listError.code, 'INVALID_RESPONSE'); assert.equal(controller.getSnapshot().workspaces.length, 1);
});
test('explicit recovery discard removes only local state and never calls a delete API', async () => {
  const { controller, recovery, calls } = setup(); recovery.write(A, { name: 'a', slug: 'a' }, K); await controller.start();
  controller.discardRecovery(); assert.equal(recovery.read(A), null); assert.equal(calls.length, 0);
});
