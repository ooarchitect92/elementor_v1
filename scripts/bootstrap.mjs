import {readFile, writeFile, access, mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, '.env');
try { await access(target); console.log('.env already exists; no credentials changed.'); }
catch {
  const example = await readFile(path.join(root,'.env.example'),'utf8');
  const content = example.replaceAll('GENERATE_LOCALLY', () => randomBytes(24).toString('hex'));
  await writeFile(target, content, {mode: 0o600, flag: 'wx'});
  console.log('Created local-only .env with random credentials. Values were not printed.');
}
await mkdir(path.join(root,'.foundation'), {recursive: true});
// Compose validates optional env_file paths even when a profile is off.
try { await access(path.join(root,'backend/.env')); }
catch {
  await writeFile(path.join(root,'backend/.env'), '# Configure this file from backend/.env.example before enabling legacy-app.\n', {mode: 0o600, flag: 'wx'});
  console.log('Created empty backend/.env placeholder; legacy-app still requires configuration.');
}
console.log('Next: npm ci; npm run check; npm run infra:up; npm run infra:init.');
