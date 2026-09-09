import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { siteLinkClient, SiteLinkClientError, type LinkedSite } from './site-links-client';
interface Props { tenantId: string; workspaceId: string; manageable: boolean; archived: boolean }
const button = 'rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50';
/** Parent keys this component by authenticated user/tenant/workspace. Nothing is
 * persisted globally; aborted results are also fenced by a local generation.
 */
export default function SiteLinksPanel({ tenantId, workspaceId, manageable, archived }: Props) {
  const api = useMemo(() => siteLinkClient(import.meta.env.VITE_API_URL || 'http://localhost:5000', tenantId, workspaceId), [tenantId, workspaceId]);
  const [linked, setLinked] = useState<LinkedSite[]>([]), [owned, setOwned] = useState<LinkedSite[]>([]);
  const [linkedCursor, setLinkedCursor] = useState<string | null>(null), [ownedCursor, setOwnedCursor] = useState<string | null>(null);
  const [siteId, setSiteId] = useState(''), [remove, setRemove] = useState<LinkedSite | null>(null);
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false);
  const epoch = useRef(0), pending = useRef<AbortController | null>(null), lock = useRef(false);
  function failure(cause: unknown) {
    const blocked = cause instanceof SiteLinkClientError && (cause.status === 401 || cause.status === 403);
    if (blocked) { setLinked([]); setOwned([]); setRemove(null); setDenied(true); }
    setLoaded(false); setError(cause instanceof SiteLinkClientError ? cause.message : 'The result could not be confirmed. Refresh before another change.');
  }
  async function refresh() {
    if (lock.current) return;
    const ticket = ++epoch.current; pending.current?.abort(); const abort = new AbortController(); pending.current = abort;
    lock.current = true; setBusy(true); setLoaded(false); setError(''); setLinked([]); setOwned([]); setSiteId(''); setRemove(null);
    try {
      const [a, b] = await Promise.all([api.list('linked', null, abort.signal), manageable ? api.list('owned', null, abort.signal) : Promise.resolve({ sites: [], nextCursor: null })]);
      if (ticket !== epoch.current) return;
      setLinked(a.sites); setLinkedCursor(a.nextCursor); setOwned(b.sites); setOwnedCursor(b.nextCursor); setLoaded(true); setDenied(false);
    } catch (cause) { if (ticket === epoch.current) failure(cause); }
    finally { if (ticket === epoch.current) { lock.current = false; setBusy(false); } }
  }
  useEffect(() => {
    void refresh();
    return () => { epoch.current++; pending.current?.abort(); lock.current = false; };
    // The component is remounted on tenant/workspace/user changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, manageable]);
  async function more(view: 'linked' | 'owned') {
    const cursor = view === 'linked' ? linkedCursor : ownedCursor;
    if (!cursor || lock.current || !loaded) return;
    lock.current = true; setBusy(true); const ticket = epoch.current; const abort = new AbortController(); pending.current = abort;
    try {
      const page = await api.list(view, cursor, abort.signal); if (ticket !== epoch.current) return;
      const rows = [...(view === 'linked' ? linked : owned), ...page.sites];
      if (new Set(rows.map(row => row.id)).size !== rows.length) throw new SiteLinkClientError('INVALID_RESPONSE');
      if (view === 'linked') { setLinked(rows); setLinkedCursor(page.nextCursor); } else { setOwned(rows); setOwnedCursor(page.nextCursor); }
    } catch (cause) { if (ticket === epoch.current) failure(cause); }
    finally { if (ticket === epoch.current) { lock.current = false; setBusy(false); } }
  }
  async function change(kind: 'attach' | 'detach', site: string, link?: string) {
    if (lock.current || !manageable || !loaded || denied || (kind === 'attach' && archived)) return;
    lock.current = true; setBusy(true); setNotice(''); setError(''); const ticket = epoch.current, abort = new AbortController(); pending.current = abort;
    try {
      if (kind === 'attach') await api.attach(site, abort.signal); else if (link) await api.detach(site, link, abort.signal); else return;
      if (ticket !== epoch.current) return;
      setNotice(kind === 'attach' ? 'Website link acknowledged by the server.' : 'Workspace link removed. The website and editor access are unchanged.');
      lock.current = false; await refresh();
    } catch (cause) { if (ticket === epoch.current) failure(cause); }
    finally { if (ticket === epoch.current) { lock.current = false; setBusy(false); } }
  }
  return <section className="mt-4 space-y-3 border-t border-slate-200 pt-4" aria-label="Workspace website assignments" aria-busy={busy}>
    <p className="text-sm text-slate-600">Only websites you own are shown. Linking organizes them; it does not transfer ownership, share drafts, change publishing, or alter collaborator access.</p>
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}<p className="mt-1">No automatic write retries. Refresh and review the current assignment before another change.</p></div>}
    {denied ? <p className="text-sm font-semibold">Refresh your tenant memberships from the workspace page before continuing.</p> : <button className={button} disabled={busy} onClick={() => void refresh()}>Refresh website assignments</button>}
    {busy && <p role="status" className="text-sm text-slate-500">Checking website assignments…</p>}
    {loaded && !linked.length && <p className="text-sm text-slate-500">No websites you own are linked here.</p>}
    {linked.map(site => <div key={site.id} className="rounded-lg border border-slate-100 p-3">
      <p className="break-words font-semibold text-slate-800">{site.name}</p>
      <div className="mt-2 flex flex-wrap gap-3 text-sm">
        {!denied && <Link className="font-semibold text-blue-700 underline" to={`/editor/${site.id}`}>Open existing editor</Link>}
        {manageable && <button className={button} disabled={busy || !loaded} onClick={() => setRemove(site)}>Review unlink</button>}
      </div>
    </div>)}
    {loaded && linkedCursor && <button className={button} disabled={busy} onClick={() => void more('linked')}>Load more linked websites</button>}
    {remove && manageable && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      <p>Remove the workspace link for <strong>{remove.name}</strong>? This does not delete the website or unpublish it.</p>
      <div className="mt-2 flex gap-3"><button className={button} disabled={busy || !loaded} onClick={() => void change('detach', remove.id, remove.linkId ?? undefined)}>Confirm unlink</button><button className={button} disabled={busy} onClick={() => setRemove(null)}>Cancel unlink</button></div>
    </div>}
    {manageable && !denied && <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (siteId) void change('attach', siteId); }}>
      <label className="block text-sm font-semibold text-slate-700">One of my websites
        <select aria-label="Website to link" value={siteId} onChange={event => setSiteId(event.target.value)} disabled={busy || !loaded || archived} className="mt-1 block w-full min-w-0 rounded-lg border border-slate-200 p-2 text-sm">
          <option value="">Select a website you own</option>{owned.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <p className="text-xs text-slate-500">This is your owned-site list, not an eligibility guarantee. A website can be linked to only one workspace. Unlink its existing assignment before moving it.</p>
      {archived && <p className="text-sm text-amber-800">Restore this workspace before adding a website.</p>}
      <div className="flex flex-wrap gap-2"><button className={button} type="submit" disabled={busy || !loaded || archived || !siteId}>Link website</button>
      {loaded && ownedCursor && <button className={button} type="button" disabled={busy} onClick={() => void more('owned')}>Load more owned websites</button>}</div>
    </form>}
  </section>;
}
