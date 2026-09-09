import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../../context/AuthContext';
import { canManage, createWorkspaceClient, type Workspace } from './workspace-client';
import { WorkspaceController, WorkspaceRecovery, type UiIssue, type WorkspaceState } from './workspace-controller';

const button = 'rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50';
const primary = 'rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50';
const input = 'mt-1 block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100';
const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6';

function Issue({ issue }: { issue: UiIssue | null }) {
  if (!issue) return null;
  return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
    <p>{issue.message}</p>
    {issue.uncertain && <p className="mt-2 font-semibold">The outcome is not confirmed. An interrupted request may still have completed on the server.</p>}
    {issue.traceId && <p className="mt-2 break-all text-xs">Support reference: <code>{issue.traceId}</code></p>}
  </div>;
}

/** Reused in the existing dashboard tab and the authenticated /workspaces route. */
export default function WorkspacePanel() {
  const { user } = useAuth();
  if (!user || user.status !== 'ACTIVE') return null;
  return <WorkspaceManager key={user.id} userId={user.id} apiUrl={import.meta.env.VITE_API_URL || 'http://localhost:5000'} />;
}

function WorkspaceManager({ userId, apiUrl }: { userId: string; apiUrl: string }) {
  const controller = useMemo(() => {
    try {
      return new WorkspaceController(createWorkspaceClient(apiUrl, userId), new WorkspaceRecovery(userId, () => window.sessionStorage));
    } catch { return null; }
  }, [apiUrl, userId]);
  if (!controller) return <div role="alert" className={card}>Workspace API configuration is invalid. Ask the operator to check VITE_API_URL.</div>;
  return <WorkspaceControllerView controller={controller} />;
}

export function WorkspaceControllerView({ controller }: { controller: WorkspaceController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { void controller.start(); return () => controller.stop(); }, [controller]);
  useEffect(() => {
    if (!state.busy && !state.pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.busy, state.pending]);
  return <div className="space-y-5" data-testid="workspace-panel">
    <section className={card} aria-labelledby="workspace-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="workspace-heading" className="text-xl font-bold text-slate-900">Manage your workspaces</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">Choose an account tenant to manage its workspaces. Permissions come from your current tenant membership, not your platform role.</p>
        </div>
        <button className={button} disabled={state.busy || state.phase === 'loading'} onClick={() => void controller.start()}>Refresh memberships</button>
      </div>
      {state.phase === 'loading' && <p role="status" className="mt-5 text-sm text-slate-500">Loading tenant memberships…</p>}
      {state.phase === 'auth-required' && <div className="mt-5 space-y-3"><Issue issue={state.error} /><a href="/login" className="inline-block font-semibold text-blue-700 underline">Sign in again</a></div>}
      {state.phase === 'error' && <div className="mt-5"><Issue issue={state.error} /></div>}
      {state.phase === 'no-tenants' && <div role="status" className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
        <p className="font-semibold text-slate-900">No active tenant membership</p>
        <p className="mt-1">Ask the platform operator to provision your tenant membership. This screen does not automatically create a tenant or move your existing websites.</p>
      </div>}
      {state.phase === 'ready' && <div className="mt-5 max-w-xl">
        <label htmlFor="workspace-tenant" className="text-sm font-semibold text-slate-700">Account tenant</label>
        <select id="workspace-tenant" className={input} value={state.tenantId} disabled={state.busy} onChange={event => void controller.selectTenant(event.target.value)}>
          <option value="">Select a tenant</option>
          {state.memberships.map(tenant => <option key={tenant.tenantId} value={tenant.tenantId}>{tenant.tenantName} — {tenant.role}</option>)}
        </select>
        {!state.tenantId && <p className="mt-2 text-sm text-slate-500">Choose a tenant explicitly before loading workspace data.</p>}
      </div>}
    </section>
    {state.phase === 'ready' && state.tenantId && <TenantWorkspaceView key={state.tenantId} state={state} controller={controller} />}
  </div>;
}

function TenantWorkspaceView({ state, controller }: { state: WorkspaceState; controller: WorkspaceController }) {
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<Workspace['status']>('ACTIVE');
  const [discardConfirmed, setDiscardConfirmed] = useState(false);
  const [filter, setFilter] = useState<'ALL' | Workspace['status']>('ALL');
  const member = state.memberships.find(membership => membership.tenantId === state.tenantId);
  const manageable = canManage(member?.role);
  const blockedUpdate = !!state.mutationError?.uncertain || state.mutationError?.code === 'WORKSPACE_VERSION_CONFLICT';
  const visible = state.workspaces.filter(workspace => filter === 'ALL' || workspace.status === filter);
  function edit(workspace: Workspace, status = workspace.status) {
    setEditing({ ...workspace }); setEditName(workspace.name); setEditStatus(status);
  }
  async function cancelEdit() { setEditing(null); await controller.discardDraftAndReload(); }
  return <>
    <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm leading-relaxed text-blue-900">
      <strong>Workspace management only.</strong> Existing websites and team collaboration stay unchanged. Website assignment, tenant onboarding, and plan quotas are not enabled by this screen.
    </div>
    {state.notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{state.notice}</p>}
    <Issue issue={state.mutationError} />
    <Issue issue={state.recoveryError} />
    {(state.pending || state.recoveryError) && <section className={card} aria-label="Workspace request recovery">
      <h3 className="font-bold text-slate-900">{state.busy ? 'Creation request in progress' : 'Workspace creation recovery'}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">The original request is saved in this browser tab. Retry the same request to recover its receipt without creating a duplicate. Recovery metadata is not a server-side workspace.</p>
      {state.pending && <p className="mt-3 break-words text-sm"><strong>{state.pending.name}</strong> <span className="font-mono text-slate-500">/{state.pending.slug}</span></p>}
      <div className="mt-4 flex flex-wrap gap-3">
        {state.pending && <button className={primary} disabled={!manageable || state.busy} onClick={() => void controller.retryCreate()}>{state.busy ? 'Awaiting acknowledgement…' : 'Retry original request'}</button>}
        {state.recoveryError && <button className={button} disabled={state.busy} onClick={() => void controller.selectTenant(state.tenantId)}>Retry recovery access</button>}
        <button className={button} disabled={state.busy} onClick={() => setDiscardConfirmed(value => !value)}>Review discarding recovery</button>
      </div>
      {discardConfirmed && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p>Discarding this record does not cancel the original server request. Check the workspace list first. A workspace already created on the server will remain; its slug is still reserved.</p>
        <button className={`${button} mt-3`} disabled={state.busy} onClick={() => { controller.discardRecovery(); setDiscardConfirmed(false); }}>Discard local recovery record</button>
      </div>}
    </section>}
    {manageable && !state.pending && !state.recoveryError && <section className={card} aria-labelledby="create-workspace-heading">
      <h3 id="create-workspace-heading" className="font-bold text-slate-900">Create workspace</h3>
      <form className="mt-4 space-y-4" onSubmit={async event => {
        event.preventDefault();
        if (await controller.create({ name: newName, slug: newSlug })) { setNewName(''); setNewSlug(''); }
      }}>
        <fieldset disabled={state.busy || state.loadingList || !!state.listError || !!editing} className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold text-slate-700">Workspace name
            <input className={input} name="workspaceName" value={newName} onChange={event => setNewName(event.target.value)} maxLength={120} required autoComplete="off" placeholder="Marketing" />
          </label>
          <label className="text-sm font-semibold text-slate-700">Workspace slug
            <input className={input} name="workspaceSlug" value={newSlug} onChange={event => setNewSlug(event.target.value)} maxLength={63} pattern="[a-z0-9]+(-[a-z0-9]+)*" required autoComplete="off" spellCheck={false} placeholder="marketing" aria-describedby="workspace-slug-help" />
          </label>
        </fieldset>
        <p id="workspace-slug-help" className="text-xs text-slate-500">Use lowercase letters, numbers, and internal hyphens. The slug cannot be renamed and remains reserved when archived.</p>
        <button type="submit" className={primary} disabled={state.busy || state.loadingList || !!state.listError || !!editing}>Create workspace</button>
      </form>
    </section>}
    {!manageable && <p className="text-sm text-slate-600">Your {member?.role.toLowerCase()} membership can view workspaces. An active tenant owner or administrator is required to create or change them.</p>}
    {editing && manageable && <section className={card} aria-labelledby="edit-workspace-heading">
      <h3 id="edit-workspace-heading" className="font-bold text-slate-900">Edit workspace: {editing.name}</h3>
      <p className="mt-2 text-sm text-slate-500">Editing server version <code>{editing.version}</code>. Archiving changes workspace status only; it does not delete websites or unpublish content.</p>
      <form className="mt-4 space-y-4" onSubmit={async event => {
        event.preventDefault();
        if (await controller.update(editing, { name: editName, status: editStatus, expectedVersion: editing.version })) setEditing(null);
      }}>
        <fieldset disabled={state.busy} className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold text-slate-700">New workspace name
            <input name="editWorkspaceName" className={input} value={editName} onChange={event => setEditName(event.target.value)} required maxLength={120} autoComplete="off" />
          </label>
          <label className="text-sm font-semibold text-slate-700">Workspace status
            <select name="editWorkspaceStatus" className={input} value={editStatus} onChange={event => setEditStatus(event.target.value as Workspace['status'])}>
              <option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option>
            </select>
          </label>
        </fieldset>
        {blockedUpdate && <p className="text-sm font-semibold text-amber-800">Your draft is still shown above. Copy any changes you need, then discard the draft and reload the server version. Saving again is blocked until that review.</p>}
        <div className="flex flex-wrap gap-3">
          <button className={primary} type="submit" disabled={state.busy || state.loadingList || !!state.listError || blockedUpdate}>{state.busy ? 'Saving…' : 'Save workspace changes'}</button>
          <button className={button} type="button" disabled={state.busy} onClick={() => void cancelEdit()}>Discard draft and reload</button>
        </div>
      </form>
    </section>}
    <section className={card} aria-labelledby="workspace-list-heading" aria-busy={state.loadingList}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 id="workspace-list-heading" className="text-lg font-bold text-slate-900">{member?.tenantName} workspaces</h3>
          <p className="mt-1 text-sm text-slate-500">{state.workspaces.length} loaded. Counts and filters apply only to loaded pages.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-slate-600">Filter loaded workspaces
            <select className={input} value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
              <option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option>
            </select>
          </label>
          <button className={button} disabled={state.busy || state.loadingList} onClick={() => void controller.loadPage()}>Refresh workspaces</button>
        </div>
      </div>
      <div className="mt-4"><Issue issue={state.listError} /></div>
      {state.loadingList && <p role="status" className="my-4 text-sm text-slate-500">Loading workspaces…</p>}
      {!state.loadingList && !state.listError && visible.length === 0 && <p role="status" className="mt-5 rounded-xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">{state.workspaces.length ? 'No loaded workspaces match this filter.' : 'No workspaces have been created in this tenant.'}</p>}
      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        {visible.map(workspace => <article key={workspace.id} data-workspace-id={workspace.id} className="min-w-0 rounded-xl border border-slate-200 p-4">
          <div className="flex items-start justify-between gap-3">
            <h4 className="min-w-0 break-words font-bold text-slate-900">{workspace.name}</h4>
            <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${workspace.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{workspace.status}</span>
          </div>
          <p className="mt-1 break-all font-mono text-xs text-slate-500">/{workspace.slug}</p>
          <p className="mt-3 text-xs text-slate-500">Version {workspace.version} · Updated {new Date(workspace.updatedAt).toLocaleString()}</p>
          {manageable && <div className="mt-4 flex flex-wrap gap-2">
            <button className={button} disabled={state.busy || state.loadingList || !!state.listError || !!editing || !!state.pending || blockedUpdate} onClick={() => edit(workspace)} aria-label={`Edit ${workspace.name}`}>Rename / manage</button>
            <button className={button} disabled={state.busy || state.loadingList || !!state.listError || !!editing || !!state.pending || blockedUpdate} onClick={() => edit(workspace, workspace.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')} aria-label={`${workspace.status === 'ACTIVE' ? 'Archive' : 'Restore'} ${workspace.name}`}>{workspace.status === 'ACTIVE' ? 'Review archive' : 'Review restore'}</button>
          </div>}
        </article>)}
      </div>
      {state.nextCursor && <button className={`${button} mt-5`} disabled={state.loadingList || state.busy} onClick={() => void controller.loadPage(state.nextCursor)}>Load more workspaces</button>}
    </section>
  </>;
}
