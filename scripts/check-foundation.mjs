import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const read=async(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");
const registry=JSON.parse(await read("docs/team/work-packages.json"));
if(registry.packages.length!==36||new Set(registry.packages.map((item)=>item.id)).size!==36)throw new Error("Work-package registry must retain 36 distinct IDs");
const workers=JSON.parse(await read("workers/registry.json"));
if(workers.enabled&&!workers.leaseRecoveryImplemented)throw new Error("Cannot enable workers without durable recovery");
if(workers.leaseRecoveryImplemented)for(const path of ["workers/shared/pg-stores.ts","workers/shared/rabbit-worker.ts","workers/outbox/main.ts","scripts/smoke-runtime.mjs","infrastructure/postgres/002_runtime.sql"])await read(path);
const publish=workers.handlers?.find((handler)=>handler.queue==="publish.build");
if(publish?.status==="implemented-and-integration-gated")for(const path of ["workers/publish/main.ts","workers/publish/publish-adapter.ts","workers/publish/release-payload.ts","scripts/smoke-publish-job.mjs","infrastructure/postgres/003_job_resources.sql","backend/prisma/manual/005_release_private.sql","backend/src/modules/jobs-v2/jobs.routes.ts","backend/src/modules/jobs-v2/jobs.service.ts"])await read(path);
const packageJson=JSON.parse(await read("package.json"));
for(const dependency of ["redis","amqplib","kafkajs","pg"])if(!packageJson.dependencies?.[dependency])throw new Error(`Runtime dependency missing: ${dependency}`);
for(const script of ["runtime:smoke","publish:smoke","backend-redis:smoke","worker:outbox","worker:publish"])if(!packageJson.scripts?.[script])throw new Error(`Runtime script missing: ${script}`);
const prisma=await read("backend/src/config/prisma.ts");if(/ALTER TABLE|ALTER TYPE|ensureDbSchema/.test(prisma))throw new Error("Runtime migration reintroduced");
for(const file of ["backend/src/services/website.service.ts","backend/src/services/template.service.ts","backend/src/services/form/form.service.ts"])if(/CREATE TABLE|ALTER TABLE|initWebsiteTable\(\)|initTemplateTable\(\)|initFormSubmissionsTable\(\)/.test(await read(file)))throw new Error(`Runtime content DDL reintroduced: ${file}`);
const api=JSON.parse(await read("docs/api/openapi.json"));if(api.openapi!=="3.1.0")throw new Error("Unexpected OpenAPI version");if(!api.paths?.["/api/v2/websites/{websiteId}/publish-jobs"])throw new Error("Publish job API is missing from OpenAPI");
for(const file of await readdir(new URL(".",import.meta.url))){if(!file.endsWith(".mjs"))continue;const checked=spawnSync(process.execPath,["--check",fileURLToPath(new URL(file,import.meta.url))],{encoding:"utf8"});if(checked.status!==0)throw new Error(checked.stderr);}
console.log("Foundation registry, runtime dependencies, private release boundary, migration guards, API spec and script syntax passed.");
