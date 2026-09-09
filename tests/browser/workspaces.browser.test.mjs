/** Real built React UI in headless Chrome, against an explicitly isolated HTTP
 * fixture. These are browser/transport tests, NOT live Prisma/PostgreSQL proof.
 * No package/browser download, customer account, API token or external API is used.
 */
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = resolve(ROOT, 'frontend/dist');
const ORIGIN = 'http://127.0.0.1:4273';
const U = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const W = '44444444-4444-4444-8444-444444444444';
const membership = (tenantId = A, role = 'OWNER') => ({ userId: U, tenantId, tenantName: tenantId === A ? 'Tenant A' : 'Tenant B', role, version: '1', tenantStatus: 'ACTIVE', membershipStatus: 'ACTIVE' });
const row = (tenantId = A, name = 'Original') => ({ id: W, tenantId, name, slug: name.toLowerCase().replaceAll(' ', '-'), status: 'ACTIVE', version: '1', createdBy: U, createdAt: '2026-09-09T10:00:00.000Z', updatedAt: '2026-09-09T10:00:00.000Z' });
let state;
function reset(changes = {}) { state = { members: [membership()], rows: new Map([[A, []], [B, []]]), receipts: new Map(), createRequests: [], patchRequests: [], listRequests: [], role: 'USER', expired: false, failMemberships: false, uncertainCreate: false, conflict: false, delayA: false, ...changes }; }
let webServer, apiServer, chrome, socket, profile, browser;
const runtimeErrors = [];
async function listen(server, port) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 65536) throw new Error('Oversized fixture request'); }
  return JSON.parse(text || '{}');
}
async function handleApi(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-ForgeStudio-Tenant,X-ForgeStudio-Request,Idempotency-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://127.0.0.1:5055');
  if (state.expired) return json(res, 401, { success: false, code: 'SESSION_NOT_ACTIVE' });
  if (url.pathname === '/api/v1/auth/me') return json(res, 200, { success: true, data: { user: { id: U, fullName: 'Browser Fixture', email: null, phone: null, role: state.role, status: 'ACTIVE', emailVerified: true, phoneVerified: false, lastLoginAt: null } } });
  if (url.pathname === '/api/v1/tenancy/memberships') return state.failMemberships ? json(res, 503, { success: false }) : json(res, 200, { success: true, tenants: state.members });
  if (url.pathname === '/api/websites') return json(res, 200, { success: true, websites: [] });
  if (!url.pathname.startsWith('/api/v1/tenancy/workspaces')) return json(res, 404, { success: false });
  const tenant = req.headers['x-forgestudio-tenant']; const member = state.members.find(m => m.tenantId === tenant);
  if (!member) return json(res, 403, { success: false, code: 'TENANT_ACCESS_DENIED' });
  if (req.method === 'GET') {
    state.listRequests.push(tenant);
    const rows = structuredClone(state.rows.get(tenant) ?? []);
    if (state.delayA && tenant === A) await pause(350);
    return json(res, 200, { success: true, workspaces: rows, nextCursor: null });
  }
  if (!['OWNER', 'ADMIN'].includes(member.role)) return json(res, 403, { success: false, code: 'WORKSPACE_PERMISSION_DENIED' });
  if (req.headers.origin !== ORIGIN || req.headers['x-forgestudio-request'] !== 'workspace-v1') return json(res, 403, { success: false, code: 'REQUEST_ORIGIN_DENIED' });
  const payload = await body(req);
  if (req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    state.createRequests.push({ tenant, key, payload, headers: { ...req.headers } });
    if (!key) return json(res, 400, { success: false, code: 'INVALID_INPUT' });
    const receiptKey = `${tenant}:${key}`;
    let receipt = state.receipts.get(receiptKey);
    if (!receipt) {
      receipt = { ...row(tenant, payload.name), slug: payload.slug };
      state.receipts.set(receiptKey, receipt); state.rows.get(tenant).push(structuredClone(receipt));
    }
    if (state.uncertainCreate) { state.uncertainCreate = false; return json(res, 503, { success: false, code: 'SERVICE_UNAVAILABLE' }); }
    return json(res, 201, { success: true, workspace: receipt });
  }
  state.patchRequests.push({ tenant, payload });
  const current = state.rows.get(tenant)[0];
  if (state.conflict) { state.conflict = false; current.name = 'Remote change'; current.version = '2'; return json(res, 409, { success: false, code: 'WORKSPACE_VERSION_CONFLICT' }); }
  if (payload.expectedVersion !== current.version) return json(res, 409, { success: false, code: 'WORKSPACE_VERSION_CONFLICT' });
  current.name = payload.name ?? current.name; current.status = payload.status ?? current.status;
  current.version = (BigInt(current.version) + 1n).toString();
  return json(res, 200, { success: true, workspace: current });
}

before(async () => {
  assert.equal(process.env.WORKSPACE_BROWSER_TEST, '1', 'Explicit WORKSPACE_BROWSER_TEST=1 is required. Only loopback fixture ports 4273/5055 are used.');
  assert.ok(existsSync(join(DIST, 'index.html')), 'Build frontend with VITE_API_URL=http://127.0.0.1:5055 first');
  reset();
  webServer = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
      const candidate = resolve(DIST, `.${pathname}`);
      if (candidate !== DIST && !candidate.startsWith(DIST + sep)) { res.writeHead(403); res.end(); return; }
      const file = extname(candidate) ? candidate : join(DIST, 'index.html');
      const content = await readFile(file);
      const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[extname(file)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  apiServer = createServer((req, res) => { handleApi(req, res).catch(() => { if (!res.headersSent) json(res, 500, { success: false }); else res.end(); }); });
  await listen(webServer, 4273); await listen(apiServer, 5055);
  const binary = [process.env.CHROME_BIN, 'google-chrome', 'chromium', 'chromium-browser'].filter(Boolean).find(path => spawnSync(path, ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0);
  assert.ok(binary, 'A local Chrome/Chromium binary is required; the browser test never silently skips');
  profile = await mkdtemp(join(tmpdir(), 'forgestudio-workspace-browser-'));
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--disable-extensions', '--no-proxy-server', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await pause(100); }
  }
  assert.ok(port, 'Chrome did not start its loopback DevTools endpoint');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map();
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    } else if (message.method === 'Page.javascriptDialogOpening') { void call('Page.handleJavaScriptDialog', { accept: true }); }
    else if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
  });
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  browser = { call, evaluate,
    async wait(expression) { for (let i = 0; i < 150; i++) { try { if (await evaluate(expression)) return; } catch (error) { if (!/context|navigation/i.test(error.message)) throw error; } await pause(100); } throw new Error(`UI wait timed out: ${expression}\n${await evaluate('document.body.innerText')}`); },
    async click(label) { await evaluate(`(() => {const b=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled); if(!b)throw new Error('Enabled control not found'); b.click();})()`); },
    async value(selector, value) { await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('Field not found'); const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`); },
  };
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1365, height: 1000, deviceScaleFactor: 1, mobile: false });
});
after(async () => {
  socket?.close();
  if (chrome && chrome.exitCode === null) { chrome.kill('SIGTERM'); await Promise.race([new Promise(resolve => chrome.once('close', resolve)), pause(3000)]); if (chrome.exitCode === null) chrome.kill('SIGKILL'); }
  for (const server of [webServer, apiServer]) if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  // Chrome child processes can finish profile writes just after the parent exits.
  // Retry bounded ENOTEMPTY/EBUSY cleanup errors; still fail if cleanup cannot finish.
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
afterEach(() => { assert.deepEqual(runtimeErrors.splice(0), [], 'Unexpected browser runtime errors'); });
let navigation = 0;
async function open(path = '/workspaces', clean = true) {
  if (clean) { try { await browser.evaluate('sessionStorage.clear()'); } catch { /* about:blank */ } }
  const target = new URL(path, ORIGIN); target.searchParams.set('__workspace_test', String(++navigation));
  await browser.call('Page.navigate', { url: target.href });
  await browser.wait(`location.href===${JSON.stringify(target.href)} && document.readyState==='complete' && !!document.querySelector('[data-testid=workspace-panel]')`);
}
async function ready() { await browser.wait("!!document.querySelector('#workspace-list-heading') && !document.body.innerText.includes('Loading workspaces…')"); }
const hasText = text => `document.body.innerText.includes(${JSON.stringify(text)})`;

test('browser: existing dashboard tab exposes workspace UI; create, rename, archive and restore call the real client contract', { timeout: 30000 }, async () => {
  reset(); await open('/dashboard?tab=workspaces'); await ready();
  assert.equal(await browser.evaluate("[...document.querySelectorAll('aside button')].some(e=>e.textContent.includes('Workspaces'))"), true);
  await browser.value('[name=workspaceName]', 'Marketing'); await browser.value('[name=workspaceSlug]', 'marketing'); await browser.click('Create workspace');
  await browser.wait("!!document.querySelector('[aria-label=\"Edit Marketing\"]')");
  assert.equal(state.createRequests.length, 1); assert.equal(state.createRequests[0].headers['x-forgestudio-request'], 'workspace-v1'); assert.ok(state.createRequests[0].key);
  await browser.evaluate("document.querySelector('[aria-label=\"Edit Marketing\"]').click()");
  await browser.value('[name=editWorkspaceName]', 'Marketing Europe'); await browser.click('Save workspace changes');
  await browser.wait("!!document.querySelector('[aria-label=\"Edit Marketing Europe\"]') && !document.querySelector('[name=editWorkspaceName]')");
  await browser.click('Review archive'); await browser.click('Save workspace changes'); await browser.wait("!!document.querySelector('[aria-label=\"Restore Marketing Europe\"]')");
  await browser.click('Review restore'); await browser.click('Save workspace changes'); await browser.wait("!!document.querySelector('[aria-label=\"Archive Marketing Europe\"]')");
  assert.deepEqual(state.patchRequests.map(r => r.payload.expectedVersion), ['1', '2', '3']);
  assert.equal(state.rows.get(A)[0].version, '4');
});
test('browser: multiple tenants require selection; stale tenant responses cannot replace viewer data', { timeout: 30000 }, async () => {
  reset({ members: [membership(), membership(B, 'VIEWER')], rows: new Map([[A, [row(A, 'Private A')]], [B, [row(B, 'Visible B')]]]), delayA: true });
  await open(); await browser.wait(hasText('Choose a tenant explicitly')); assert.equal(state.listRequests.length, 0);
  await browser.value('#workspace-tenant', A); await browser.value('#workspace-tenant', B); await ready(); await pause(500);
  assert.equal(await browser.evaluate(hasText('Visible B')), true); assert.equal(await browser.evaluate(hasText('Private A')), false);
  assert.equal(await browser.evaluate("!!document.querySelector('[name=workspaceName]')"), false);
});
test('browser: uncertain create survives page reload and retries the same key without another workspace', { timeout: 30000 }, async () => {
  reset({ uncertainCreate: true }); await open(); await ready();
  await browser.value('[name=workspaceName]', 'Recover me'); await browser.value('[name=workspaceSlug]', 'recover-me'); await browser.click('Create workspace');
  await browser.wait(hasText('The outcome is not confirmed')); const key = state.createRequests[0].key;
  await open('/workspaces', false); await ready(); await browser.click('Retry original request'); await browser.wait("!!document.querySelector('[aria-label=\"Edit Recover me\"]') && !document.body.innerText.includes('Retry original request')");
  assert.equal(state.createRequests.length, 2); assert.equal(state.createRequests[1].key, key); assert.equal(state.rows.get(A).length, 1);
});
test('browser: conflict preserves draft, blocks repeated PATCH, and requires explicit reload', { timeout: 30000 }, async () => {
  reset({ rows: new Map([[A, [row()]], [B, []]]), conflict: true }); await open(); await ready(); await browser.click('Rename / manage');
  await browser.value('[name=editWorkspaceName]', 'My draft'); await browser.click('Save workspace changes'); await browser.wait(hasText('This workspace changed on the server'));
  assert.equal(await browser.evaluate("document.querySelector('[name=editWorkspaceName]').value"), 'My draft');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('button')].find(e=>e.textContent==='Save workspace changes').disabled"), true);
  assert.equal(state.patchRequests.length, 1); await browser.click('Discard draft and reload'); await browser.wait("!!document.querySelector('[aria-label=\"Edit Remote change\"]')");
});
test('browser: expired session removes previous workspace data and offers a fresh sign-in', { timeout: 30000 }, async () => {
  reset({ rows: new Map([[A, [row(A, 'Private workspace')]], [B, []]]) }); await open(); await ready(); state.expired = true;
  await browser.click('Refresh workspaces'); await browser.wait(hasText('Sign in again'));
  assert.equal(await browser.evaluate(hasText('Private workspace')), false); assert.equal(await browser.evaluate("document.querySelectorAll('[data-workspace-id]').length"), 0);
});
test('browser: no-tenant and failed-membership states are not confused', { timeout: 30000 }, async () => {
  reset({ members: [] }); await open(); await browser.wait(hasText('No active tenant membership'));
  reset({ failMemberships: true }); await open(); await browser.wait("!!document.querySelector('[role=alert]')");
  assert.equal(await browser.evaluate(hasText('No active tenant membership')), false);
});
test('browser: global admin navigation does not grant tenant management permissions', { timeout: 30000 }, async () => {
  reset({ role: 'ADMIN', members: [membership(A, 'VIEWER')], rows: new Map([[A, [row()]], [B, []]]) });
  await browser.call('Page.navigate', { url: ORIGIN + '/admin' }); await browser.wait(hasText('Manage workspaces')); await browser.click('Manage workspaces'); await ready();
  assert.equal(await browser.evaluate("!!document.querySelector('[name=workspaceName]')"), false);
});
test('browser: mobile workspace page has bounded width and produces a review screenshot', { timeout: 30000 }, async () => {
  reset({ rows: new Map([[A, [row(A, 'Marketing operations')]], [B, []]]) });
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await open(); await ready(); assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), true);
  await mkdir(join(ROOT, '.foundation'), { recursive: true });
  const shot = await browser.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(ROOT, '.foundation/workspace-browser-mobile.png'), Buffer.from(shot.data, 'base64'));
});
