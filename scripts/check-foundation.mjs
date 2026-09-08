import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const read=async p=>readFile(new URL(`../${p}`,import.meta.url),'utf8');
const registry=JSON.parse(await read('docs/team/work-packages.json'));
if(registry.packages.length!==36 || new Set(registry.packages.map(p=>p.id)).size!==36) throw Error('Work-package registry must retain 36 distinct IDs');
const workers=JSON.parse(await read('workers/registry.json'));
if(workers.enabled && !workers.leaseRecoveryImplemented) throw Error('Cannot enable workers without durable recovery');
const prisma=await read('backend/src/config/prisma.ts');
if(/ALTER TABLE|ALTER TYPE|ensureDbSchema/.test(prisma)) throw Error('Runtime migration reintroduced');
for (const file of ['backend/src/services/website.service.ts','backend/src/services/template.service.ts','backend/src/services/form/form.service.ts']) {
  if (/CREATE TABLE|ALTER TABLE|initWebsiteTable\(\)|initTemplateTable\(\)|initFormSubmissionsTable\(\)/.test(await read(file))) throw Error(`Runtime content DDL reintroduced: ${file}`);
}
const api=JSON.parse(await read('docs/api/openapi.json'));
if(api.openapi!=='3.1.0') throw Error('Unexpected OpenAPI version');
for(const file of await readdir(new URL('.',import.meta.url))) if(file.endsWith('.mjs')) {const checked=spawnSync(process.execPath,['--check',fileURLToPath(new URL(file,import.meta.url))],{encoding:'utf8'});if(checked.status!==0) throw Error(checked.stderr);}
console.log('Foundation registry, API spec, runtime-DDL guard and script syntax passed.');
