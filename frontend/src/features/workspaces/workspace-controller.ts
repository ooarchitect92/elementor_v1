import {
  canManage, isUuid, requestKey, validateCreate, WorkspaceClientError,
  type CreateInput, type TenantMembership, type UpdateInput, type Workspace, type WorkspaceApi,
} from './workspace-client.js';

export interface PendingCreate extends CreateInput { schema: 1; userId: string; tenantId: string; key: string }
export interface RecoveryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface UiIssue { code: string; message: string; uncertain: boolean; traceId: string | null }
export interface WorkspaceState {
  phase: 'loading' | 'ready' | 'error' | 'no-tenants' | 'auth-required';
  memberships: TenantMembership[]; tenantId: string; workspaces: Workspace[]; nextCursor: string | null;
  loadingList: boolean; busy: boolean; error: UiIssue | null; listError: UiIssue | null;
  mutationError: UiIssue | null; recoveryError: UiIssue | null; pending: PendingCreate | null; notice: string;
}
const initial = (): WorkspaceState => ({ phase: 'loading', memberships: [], tenantId: '', workspaces: [], nextCursor: null,
  loadingList: false, busy: false, error: null, listError: null, mutationError: null, recoveryError: null, pending: null, notice: '' });
function localIssue(code: string, message: string): UiIssue { return { code, message, uncertain: false, traceId: null }; }
function errorIssue(error: unknown): UiIssue {
  if (error instanceof WorkspaceClientError) return { code: error.code, message: error.message, uncertain: error.uncertain, traceId: error.traceId };
  return localIssue('REQUEST_FAILED', 'The operation could not be confirmed. Reload the current state before another change.');
}
const recoveryIssue = () => localIssue('RECOVERY_STORAGE_UNAVAILABLE', 'Recovery data could not be read or saved in this browser tab. Enable session storage before creating a workspace.');
const corruptRecoveryIssue = () => localIssue('RECOVERY_DATA_INVALID', 'Saved request recovery data is invalid. Check the workspace list before explicitly discarding it.');

/** Persist ONLY the pending creation payload/key, never credentials, membership or role.
 * The key is scoped to this authenticated user AND selected tenant. This is recovery
 * metadata, not authentication. Never erase an uncertain request on timeout/unmount.
 */
export class WorkspaceRecovery {
  private readonly userId: string;
  private readonly storage: () => RecoveryStorage;
  constructor(userId: string, storage: () => RecoveryStorage) {
    if (!isUuid(userId)) throw new Error('Invalid recovery identity');
    this.userId = userId.toLowerCase(); this.storage = storage;
  }
  private storageKey(tenantId: string): string {
    if (!isUuid(tenantId)) throw new Error('Invalid recovery tenant');
    return `forgestudio.workspace-create.v1:${this.userId}:${tenantId.toLowerCase()}`;
  }
  read(tenantId: string): PendingCreate | null {
    const text = this.storage().getItem(this.storageKey(tenantId));
    if (text === null) return null;
    if (text.length > 4096) throw new Error('Invalid recovery data');
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid recovery data');
    const row = data as Record<string, unknown>;
    if (row.schema !== 1 || row.userId !== this.userId || row.tenantId !== tenantId.toLowerCase() || !isUuid(row.key) ||
      typeof row.name !== 'string' || typeof row.slug !== 'string') throw new Error('Invalid recovery data');
    const input = validateCreate({ name: row.name, slug: row.slug });
    return { schema: 1, userId: this.userId, tenantId: tenantId.toLowerCase(), key: row.key, ...input };
  }
  write(tenantId: string, input: CreateInput, key: string): PendingCreate {
    if (!isUuid(key)) throw new Error('Invalid recovery key');
    const pending: PendingCreate = { schema: 1, userId: this.userId, tenantId: tenantId.toLowerCase(), key, ...validateCreate(input) };
    this.storage().setItem(this.storageKey(tenantId), JSON.stringify(pending));
    return pending;
  }
  clear(tenantId: string): void { this.storage().removeItem(this.storageKey(tenantId)); }
}

/** Framework-independent view model. Every asynchronous result is fenced by a
 * tenant-generation AND request sequence. Aborting fetch alone is insufficient.
 */
export class WorkspaceController {
  private state: WorkspaceState = initial();
  private readonly listeners = new Set<() => void>();
  private readonly api: WorkspaceApi;
  private readonly recovery: WorkspaceRecovery;
  private readonly newKey: () => string;
  private epoch = 0;
  private listSequence = 0;
  private readAbort: AbortController | null = null;
  private mutationAbort: AbortController | null = null;
  constructor(api: WorkspaceApi, recovery: WorkspaceRecovery, newKey = requestKey) {
    this.api = api; this.recovery = recovery; this.newKey = newKey;
  }
  getSnapshot = (): WorkspaceState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  private invalidate(): number {
    this.readAbort?.abort(); this.readAbort = null;
    this.mutationAbort?.abort(); this.mutationAbort = null;
    this.listSequence++; return ++this.epoch;
  }
  stop(): void { this.invalidate(); }
  async start(): Promise<void> {
    // Re-entrant for React StrictMode's setup/cleanup/setup. Never use stale roles.
    const previous = this.state.tenantId;
    const epoch = this.invalidate();
    const abort = new AbortController(); this.readAbort = abort;
    this.state = initial(); this.emit({});
    try {
      const memberships = await this.api.memberships(abort.signal);
      if (epoch !== this.epoch) return;
      this.emit({ phase: memberships.length ? 'ready' : 'no-tenants', memberships });
      const selected = memberships.find(m => m.tenantId === previous)?.tenantId ?? (memberships.length === 1 ? memberships[0]!.tenantId : '');
      if (selected) await this.selectTenant(selected);
    } catch (error) {
      if (epoch !== this.epoch) return;
      const issue = errorIssue(error);
      this.emit({ phase: issue.code === 'SESSION_NOT_ACTIVE' ? 'auth-required' : 'error', error: issue });
    }
  }
  async selectTenant(tenantId: string): Promise<void> {
    if (this.state.busy) return;
    if (tenantId && !this.state.memberships.some(m => m.tenantId === tenantId)) return;
    this.invalidate();
    let pending: PendingCreate | null = null; let recoveryError: UiIssue | null = null;
    if (tenantId) {
      try { pending = this.recovery.read(tenantId); } catch { recoveryError = corruptRecoveryIssue(); }
    }
    this.emit({ tenantId, workspaces: [], nextCursor: null, loadingList: false, busy: false, listError: null,
      mutationError: null, error: null, pending, recoveryError, notice: '' });
    if (tenantId) await this.loadPage();
  }
  private denyAccess(issue: UiIssue): boolean {
    if (issue.code !== 'SESSION_NOT_ACTIVE' && issue.code !== 'TENANT_ACCESS_DENIED' && issue.code !== 'WORKSPACE_PERMISSION_DENIED') return false;
    this.invalidate();
    this.emit({ phase: issue.code === 'SESSION_NOT_ACTIVE' ? 'auth-required' : 'error', error: issue,
      memberships: [], tenantId: '', workspaces: [], nextCursor: null, busy: false, loadingList: false, pending: null,
      mutationError: null, listError: null, recoveryError: null, notice: '' });
    return true;
  }
  async loadPage(after: string | null = null): Promise<void> {
    if (!this.state.tenantId || this.state.busy || (after && after !== this.state.nextCursor)) return;
    const tenant = this.state.tenantId; const epoch = this.epoch; const seq = ++this.listSequence;
    this.readAbort?.abort(); const abort = new AbortController(); this.readAbort = abort;
    this.emit({ loadingList: true, listError: null, ...(after ? {} : { workspaces: [], nextCursor: null }) });
    try {
      const page = await this.api.list(tenant, after, abort.signal);
      if (epoch !== this.epoch || seq !== this.listSequence) return;
      // Do not silently combine inconsistent pages into a misleading list.
      const rows = after ? [...this.state.workspaces, ...page.workspaces] : page.workspaces;
      if (rows.some(row => row.tenantId !== tenant) || new Set(rows.map(row => row.id)).size !== rows.length) throw new WorkspaceClientError('INVALID_RESPONSE', 502);
      this.emit({ workspaces: rows, nextCursor: page.nextCursor, loadingList: false });
    } catch (error) {
      if (epoch !== this.epoch || seq !== this.listSequence) return;
      const issue = errorIssue(error);
      if (!this.denyAccess(issue)) this.emit({ loadingList: false, listError: issue });
    }
  }
  private allowed(): boolean {
    return this.state.phase === 'ready' && !!this.state.tenantId && !this.state.busy &&
      canManage(this.state.memberships.find(m => m.tenantId === this.state.tenantId)?.role);
  }
  async create(input: CreateInput): Promise<boolean> {
    if (!this.allowed() || this.state.pending || this.state.recoveryError) return false;
    let normalized: CreateInput;
    try { normalized = validateCreate(input); } catch (error) { this.emit({ mutationError: errorIssue(error) }); return false; }
    try { this.emit({ pending: this.recovery.write(this.state.tenantId, normalized, this.newKey()), recoveryError: null }); }
    catch { this.emit({ recoveryError: recoveryIssue() }); return false; }
    return this.retryCreate();
  }
  async retryCreate(): Promise<boolean> {
    if (!this.allowed() || !this.state.pending) return false;
    const pending = this.state.pending; const epoch = this.epoch;
    const abort = this.beginMutation();
    try {
      await this.api.create(pending.tenantId, { name: pending.name, slug: pending.slug }, pending.key, abort.signal);
      if (epoch !== this.epoch) return false;
      let cleared = false;
      try { this.recovery.clear(pending.tenantId); cleared = true; } catch { /* receipt confirmed; retrying the same key is still safe */ }
      this.emit({ busy: false, pending: cleared ? null : pending,
        recoveryError: cleared ? null : recoveryIssue(),
        notice: cleared ? 'Creation acknowledged by the server. The list below is reloaded from current server state.'
          : 'Creation acknowledged, but browser recovery data could not be cleared. Do not start a different request.' });
      // A replayed receipt is the ORIGINAL creation snapshot, not the latest row.
      await this.loadPage(); return true;
    } catch (error) {
      if (epoch !== this.epoch) return false;
      const issue = errorIssue(error);
      if (!this.denyAccess(issue)) this.emit({ busy: false, mutationError: issue });
      return false;
    }
  }
  private beginMutation(): AbortController {
    this.readAbort?.abort(); this.listSequence++;
    const abort = new AbortController(); this.mutationAbort = abort;
    this.emit({ busy: true, loadingList: false, mutationError: null, notice: '' }); return abort;
  }
  async update(target: Workspace, input: UpdateInput): Promise<boolean> {
    if (!this.allowed() || target.tenantId !== this.state.tenantId || this.state.mutationError?.uncertain ||
      this.state.mutationError?.code === 'WORKSPACE_VERSION_CONFLICT') return false;
    const epoch = this.epoch; const abort = this.beginMutation();
    try {
      // The immutable editor snapshot supplies the expected version. Never replace it from a background refresh.
      await this.api.update(target.tenantId, target.id, { ...input, expectedVersion: target.version }, abort.signal);
      if (epoch !== this.epoch) return false;
      this.emit({ busy: false, notice: 'Workspace change acknowledged by the server.' });
      await this.loadPage(); return true;
    } catch (error) {
      if (epoch !== this.epoch) return false;
      const issue = errorIssue(error);
      if (!this.denyAccess(issue)) this.emit({ busy: false, mutationError: issue });
      return false;
    }
  }
  async discardDraftAndReload(): Promise<void> {
    if (this.state.busy) return;
    this.emit({ mutationError: null }); await this.loadPage();
  }
  discardRecovery(): void {
    // Caller must obtain explicit confirmation: deleting this metadata does NOT cancel a server operation.
    if (this.state.busy || !this.state.tenantId) return;
    try {
      this.recovery.clear(this.state.tenantId);
      this.emit({ pending: null, recoveryError: null, mutationError: null, notice: 'Recovery record discarded locally. Any server-created workspace remains unchanged.' });
    } catch { this.emit({ recoveryError: recoveryIssue() }); }
  }
}
