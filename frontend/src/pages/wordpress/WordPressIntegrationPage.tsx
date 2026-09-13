import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

type ConnectionStatus = "ACTIVE" | "ERROR" | "REVOKED";

interface WordPressConnection {
  id: string;
  websiteId: string;
  siteUrl: string;
  username: string;
  status: ConnectionStatus;
  capabilities: { capabilities?: Record<string, boolean>; plugin_version?: string };
  lastCheckedAt?: string | null;
  createdAt: string;
}

interface ImportRun {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  summary?: { pages?: number; posts?: number; changed?: number; inventory?: unknown };
  errorCode?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

interface SnapshotRow {
  sourceType: string;
  sourceId: string;
  sourceModified?: string | null;
  sourceHash: string;
  title?: string;
  slug?: string;
  status?: string;
  lastSeenAt: string;
}

interface PassportFinding {
  code: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  category: string;
  level: "NATIVE" | "PARTIAL" | "MANUAL" | "UNSUPPORTED";
  title: string;
  detail: string;
  recommendation: string;
  count: number;
  samples: string[];
}

interface CompatibilityPassport {
  id: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "E";
  migrationMode: "DIRECT" | "ASSISTED" | "HEADLESS_RETAIN" | "REBUILD_RECOMMENDED";
  summary: {
    sourceItems: number;
    discoveredBlocks: number;
    activePlugins: number;
    native: number;
    partial: number;
    manual: number;
    unsupported: number;
    elementorDetected: boolean;
    woocommerceDetected: boolean;
    multisite: boolean;
  };
  findings: PassportFinding[];
  createdAt: string;
}

const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:5000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `Request failed (${response.status})`);
  return body as T;
}

function date(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Not yet";
}

function badgeClasses(value: string) {
  if (["ACTIVE", "COMPLETED", "NATIVE", "A"].includes(value)) return "bg-emerald-100 text-emerald-800";
  if (["PARTIAL", "B", "C", "RUNNING"].includes(value)) return "bg-amber-100 text-amber-800";
  if (["MANUAL", "D", "ERROR", "FAILED"].includes(value)) return "bg-orange-100 text-orange-800";
  return "bg-red-100 text-red-800";
}

export default function WordPressIntegrationPage() {
  const { websiteId = "" } = useParams<{ websiteId: string }>();
  const [connections, setConnections] = useState<WordPressConnection[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [imports, setImports] = useState<ImportRun[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [passport, setPassport] = useState<CompatibilityPassport | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pairing, setPairing] = useState({ siteUrl: "", username: "", applicationPassword: "" });

  const selected = useMemo(
    () => connections.find((connection) => connection.id === selectedId) || null,
    [connections, selectedId],
  );

  const loadConnections = useCallback(async () => {
    if (!websiteId) return;
    const body = await request<{ connections: WordPressConnection[] }>(`/api/v2/websites/${websiteId}/wordpress/connections`);
    setConnections(body.connections || []);
    setSelectedId((current) => current || body.connections?.[0]?.id || "");
  }, [websiteId]);

  const loadSelected = useCallback(async (connectionId: string) => {
    if (!websiteId || !connectionId) {
      setImports([]); setSnapshots([]); setPassport(null); return;
    }
    const [importBody, snapshotBody, passportBody] = await Promise.all([
      request<{ imports: ImportRun[] }>(`/api/v2/websites/${websiteId}/wordpress/connections/${connectionId}/imports`),
      request<{ snapshots: SnapshotRow[] }>(`/api/v2/websites/${websiteId}/wordpress/connections/${connectionId}/snapshots?limit=100`),
      request<{ passport: CompatibilityPassport | null }>(`/api/v2/websites/${websiteId}/wordpress/connections/${connectionId}/passport`),
    ]);
    setImports(importBody.imports || []);
    setSnapshots(snapshotBody.snapshots || []);
    setPassport(passportBody.passport || null);
  }, [websiteId]);

  useEffect(() => {
    loadConnections().catch((reason) => setError(reason instanceof Error ? reason.message : "Failed to load WordPress connections"));
  }, [loadConnections]);

  useEffect(() => {
    loadSelected(selectedId).catch((reason) => setError(reason instanceof Error ? reason.message : "Failed to load WordPress status"));
  }, [loadSelected, selectedId]);

  const run = async (name: string, operation: () => Promise<void>) => {
    setBusy(name); setError(""); setNotice("");
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Operation failed"); }
    finally { setBusy(""); }
  };

  const pair = () => run("pair", async () => {
    const body = await request<{ connection: WordPressConnection }>(`/api/v2/websites/${websiteId}/wordpress/connections`, {
      method: "POST", body: JSON.stringify(pairing),
    });
    setPairing({ siteUrl: "", username: "", applicationPassword: "" });
    await loadConnections();
    setSelectedId(body.connection.id);
    setNotice("WordPress connected. The Application Password is encrypted and is never returned to the browser.");
  });

  const check = () => selected && run("check", async () => {
    await request(`/api/v2/websites/${websiteId}/wordpress/connections/${selected.id}/check`, { method: "POST", body: "{}" });
    await loadConnections();
    setNotice("Connection and connector capabilities verified.");
  });

  const importSnapshot = () => selected && run("import", async () => {
    await request(`/api/v2/websites/${websiteId}/wordpress/connections/${selected.id}/import`, {
      method: "POST", body: JSON.stringify({ maxItems: 2000 }),
    });
    await loadSelected(selected.id);
    setNotice("Read-only WordPress snapshot completed. No source content was modified.");
  });

  const generatePassport = () => selected && run("passport", async () => {
    const body = await request<{ passport: CompatibilityPassport }>(`/api/v2/websites/${websiteId}/wordpress/connections/${selected.id}/passport`, {
      method: "POST", body: "{}",
    });
    setPassport(body.passport);
    setNotice("Compatibility Passport regenerated from the latest imported source fingerprint.");
  });

  const revoke = () => selected && run("revoke", async () => {
    await request(`/api/v2/websites/${websiteId}/wordpress/connections/${selected.id}`, { method: "DELETE" });
    setSelectedId(""); setImports([]); setSnapshots([]); setPassport(null);
    await loadConnections();
    setNotice("Connection revoked and encrypted credentials erased.");
  });

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">ForgeStudio Connect</p>
            <h1 className="mt-1 text-2xl font-bold">WordPress migration workspace</h1>
            <p className="mt-1 text-sm text-slate-500">Connect, inspect, import read-only snapshots and decide the safest migration path.</p>
          </div>
          <div className="flex gap-2">
            <Link to="/dashboard" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50">Dashboard</Link>
            <Link to={`/editor/${websiteId}`} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Open editor</Link>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[340px_1fr]">
        <aside className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-bold">Connect a WordPress site</h2>
            <p className="mt-1 text-xs text-slate-500">Use a dedicated WordPress Application Password with the ForgeStudio connector capability.</p>
            <div className="mt-4 space-y-3">
              <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="https://example.com" value={pairing.siteUrl} onChange={(event) => setPairing({ ...pairing, siteUrl: event.target.value })} />
              <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="WordPress username" value={pairing.username} onChange={(event) => setPairing({ ...pairing, username: event.target.value })} />
              <input type="password" autoComplete="new-password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Application Password" value={pairing.applicationPassword} onChange={(event) => setPairing({ ...pairing, applicationPassword: event.target.value })} />
              <button disabled={busy !== "" || !pairing.siteUrl || !pairing.username || !pairing.applicationPassword} onClick={pair} className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{busy === "pair" ? "Connecting…" : "Connect securely"}</button>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between"><h2 className="font-bold">Connections</h2><span className="text-xs text-slate-500">{connections.length}</span></div>
            <div className="mt-3 space-y-2">
              {connections.length === 0 && <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">No WordPress site connected.</p>}
              {connections.map((connection) => (
                <button key={connection.id} onClick={() => setSelectedId(connection.id)} className={`w-full rounded-xl border p-3 text-left transition ${selectedId === connection.id ? "border-blue-500 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}>
                  <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{connection.siteUrl}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badgeClasses(connection.status)}`}>{connection.status}</span></div>
                  <p className="mt-1 truncate text-xs text-slate-500">{connection.username} · checked {date(connection.lastCheckedAt)}</p>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="space-y-6">
          {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
          {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>}
          {!selected && <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-500">Select or connect a WordPress site to begin.</div>}

          {selected && (
            <>
              <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div><h2 className="text-lg font-bold">{selected.siteUrl}</h2><p className="text-sm text-slate-500">Connector {selected.capabilities?.plugin_version || "unknown"} · read-only source import</p></div>
                  <div className="flex flex-wrap gap-2">
                    <button disabled={busy !== ""} onClick={check} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-50">Verify</button>
                    <button disabled={busy !== "" || selected.status === "REVOKED"} onClick={importSnapshot} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === "import" ? "Importing…" : "Import snapshot"}</button>
                    <button disabled={busy !== "" || imports[0]?.status !== "COMPLETED"} onClick={generatePassport} className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === "passport" ? "Analysing…" : "Generate passport"}</button>
                    <button disabled={busy !== ""} onClick={revoke} className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-50">Revoke</button>
                  </div>
                </div>
              </section>

              {passport ? (
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div><p className="text-xs font-bold uppercase tracking-wider text-slate-500">Compatibility Passport</p><h2 className="mt-1 text-xl font-bold">Recommended path: {passport.migrationMode.replaceAll("_", " ")}</h2><p className="mt-1 text-sm text-slate-500">Generated {date(passport.createdAt)} from an immutable source fingerprint.</p></div>
                    <div className={`flex h-24 w-24 flex-col items-center justify-center rounded-full ${badgeClasses(passport.grade)}`}><span className="text-3xl font-black">{passport.grade}</span><span className="text-xs font-bold">{passport.score}/100</span></div>
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {[
                      ["Source items", passport.summary.sourceItems], ["Blocks", passport.summary.discoveredBlocks], ["Plugins", passport.summary.activePlugins],
                      ["Native", passport.summary.native], ["Manual", passport.summary.manual], ["Unsupported", passport.summary.unsupported],
                    ].map(([label, value]) => <div key={String(label)} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-bold">{value}</p></div>)}
                  </div>
                  <div className="mt-5 space-y-3">
                    {passport.findings.length === 0 && <div className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">No known portability blockers were found. A preview and business acceptance test are still required.</div>}
                    {passport.findings.map((finding, index) => (
                      <article key={`${finding.code}-${index}`} className="rounded-xl border border-slate-200 p-4">
                        <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badgeClasses(finding.level)}`}>{finding.level}</span><span className="text-xs font-bold text-slate-500">{finding.category} · {finding.count}</span><h3 className="w-full font-semibold sm:w-auto">{finding.title}</h3></div>
                        <p className="mt-2 text-sm text-slate-600">{finding.detail}</p><p className="mt-2 text-sm font-medium text-slate-800">Next action: {finding.recommendation}</p>
                        {finding.samples?.length > 0 && <p className="mt-2 truncate text-xs text-slate-400">Examples: {finding.samples.join(", ")}</p>}
                      </article>
                    ))}
                  </div>
                </section>
              ) : <section className="rounded-2xl border border-dashed border-violet-300 bg-violet-50 p-6 text-sm text-violet-900">Import a current snapshot, then generate a Compatibility Passport before approving migration or write synchronization.</section>}

              <div className="grid gap-6 xl:grid-cols-2">
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="font-bold">Import history</h2>
                  <div className="mt-3 space-y-2">{imports.slice(0, 10).map((run) => <div key={run.id} className="rounded-xl border border-slate-200 p-3"><div className="flex justify-between"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badgeClasses(run.status)}`}>{run.status}</span><span className="text-xs text-slate-500">{date(run.createdAt)}</span></div><p className="mt-2 text-sm text-slate-600">Pages {run.summary?.pages || 0} · posts {run.summary?.posts || 0} · changed {run.summary?.changed || 0}</p>{run.errorCode && <p className="mt-1 text-xs text-red-600">{run.errorCode}</p>}</div>)}{imports.length === 0 && <p className="text-sm text-slate-500">No imports yet.</p>}</div>
                </section>
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="font-bold">Latest source snapshot</h2>
                  <div className="mt-3 max-h-96 space-y-2 overflow-auto">{snapshots.map((item) => <div key={`${item.sourceType}-${item.sourceId}`} className="rounded-xl border border-slate-200 p-3"><div className="flex justify-between gap-2"><span className="truncate text-sm font-semibold">{item.title || item.slug || `${item.sourceType} ${item.sourceId}`}</span><span className="text-[10px] font-bold uppercase text-slate-400">{item.sourceType}</span></div><p className="mt-1 truncate text-xs text-slate-500">/{item.slug || ""} · {item.status || "unknown"}</p><p className="mt-1 font-mono text-[10px] text-slate-400">{item.sourceHash.slice(0, 16)}…</p></div>)}{snapshots.length === 0 && <p className="text-sm text-slate-500">No source records imported.</p>}</div>
                </section>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
