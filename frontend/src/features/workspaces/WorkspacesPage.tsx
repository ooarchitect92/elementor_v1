import { Link } from 'react-router-dom';
import WorkspacePanel from './WorkspacePanel';

export default function WorkspacesPage() {
  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-8">
        <h1 className="text-lg font-bold">ForgeStudio / Workspaces</h1>
        <Link to="/" className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">Back to dashboard</Link>
      </div>
    </header>
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-8"><WorkspacePanel /></main>
  </div>;
}
