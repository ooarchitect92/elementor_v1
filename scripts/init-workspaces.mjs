import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
if (!process.argv.includes('--development') || process.env.NODE_ENV === 'production') {
  throw new Error('Explicit --development flag required; use reviewed migration tooling in production');
}
if (!process.env.POSTGRES_USER || !process.env.POSTGRES_DB) throw new Error('Load the generated development .env first');
const result = spawnSync('docker', ['compose','exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U',process.env.POSTGRES_USER,'-d',process.env.POSTGRES_DB], {
  input: readFileSync(new URL('../infrastructure/postgres/003_workspaces.sql', import.meta.url), 'utf8'),
  encoding: 'utf8', timeout: 30000,
});
if (result.error || result.status !== 0) throw new Error('Workspace migration failed; inspect the local PostgreSQL container');
console.log('Workspace schema v3 applied to the local Compose development database. No legacy data backfill was performed.');
