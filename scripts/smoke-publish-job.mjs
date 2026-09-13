import assert from "node:assert/strict";
import { NodePostgresPool } from "../packages/platform/node-postgres.ts";
import { connectRabbitPublisher } from "../packages/platform/node-rabbitmq.ts";
import { connectKafkaPublisher } from "../packages/platform/node-kafka.ts";
import { acceptJob, tenantTransaction } from "../workers/shared/postgres.ts";
import { PgOutboxStore } from "../workers/shared/pg-stores.ts";
import { relayBatch } from "../workers/shared/outbox.ts";
import { connectJobWorker } from "../workers/shared/rabbit-worker.ts";
import { PublishAdapter, releaseContentHash } from "../workers/publish/publish-adapter.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const WEBSITE = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const JOB2 = "55555555-5555-4555-8555-555555555556";
const EVENT = "66666666-6666-4666-8666-666666666666";
const TRACE = "77777777-7777-4777-8777-777777777777";
const TRACE2 = "77777777-7777-4777-8777-777777777778";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const originalEditorData = { version: 1, elements: [{ id: "heading", type: "heading", content: "Verified release" }] };
const sourcePayload = {
  website: { id: WEBSITE, name: "Publish smoke", slug: "publish-smoke", status: "PUBLISHED" },
  editorData: originalEditorData,
  performanceSettings: {},
  customCodeSnippets: [],
  themeLocationRules: [],
};
const sourceHash = releaseContentHash(sourcePayload);

const pool = new NodePostgresPool({ ...process.env, SERVICE_NAME: "forgestudio-publish-smoke", POSTGRES_POOL_MAX: "6" });
let rabbit;
let kafka;
let worker;

async function createLegacyFixtures() {
  await pool.pool.query(`
    CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS websites(
      id uuid PRIMARY KEY,"userId" uuid NOT NULL,name text NOT NULL,slug text NOT NULL,
      status text NOT NULL DEFAULT 'DRAFT',"editorData" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "currentRevision" bigint NOT NULL DEFAULT 0,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE IF NOT EXISTS website_revisions(
      id uuid PRIMARY KEY,"websiteId" uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
      revision bigint NOT NULL,"editorData" jsonb NOT NULL,"performanceSettings" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "actorUserId" uuid NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE("websiteId",revision)
    );
    CREATE TABLE IF NOT EXISTS site_releases(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"websiteId" uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
      "releaseNumber" bigint NOT NULL,"sourceRevision" bigint NOT NULL,"requestKey" text NOT NULL,
      "requestHash" char(64) NOT NULL,"contentHash" char(64) NOT NULL,payload jsonb NOT NULL,
      status text NOT NULL CHECK(status IN ('VERIFIED','ACTIVE','RETIRED')),"createdBy" uuid NOT NULL,
      "requestAcceptedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),"createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "activatedAt" timestamptz,UNIQUE("websiteId","releaseNumber"),UNIQUE("websiteId","requestKey")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS publish_smoke_one_active ON site_releases("websiteId") WHERE status='ACTIVE';
    CREATE TABLE IF NOT EXISTS custom_code_snippets(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"websiteId" uuid NOT NULL,name text,title text,"codeType" text,
      language text,placement text,location text,scope text,"pageId" text,code text,priority integer,
      conditions jsonb,status text,"isEnabled" boolean,"isActive" boolean,"isDraft" boolean
    );
    CREATE TABLE IF NOT EXISTS theme_location_rules(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"websiteId" uuid NOT NULL,"locationType" text,
      "templateId" text,conditions jsonb,"isActive" boolean
    );
  `);
  await pool.pool.query("DELETE FROM site_releases WHERE \"websiteId\"=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM website_revisions WHERE \"websiteId\"=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM custom_code_snippets WHERE \"websiteId\"=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM theme_location_rules WHERE \"websiteId\"=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM websites WHERE id=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM users WHERE id=$1", [USER]);
  await pool.pool.query("INSERT INTO users(id) VALUES($1)", [USER]);
  await pool.pool.query(
    `INSERT INTO websites(id,"userId",name,slug,status,"editorData","currentRevision") VALUES($1,$2,'Publish smoke','publish-smoke','DRAFT',$3::jsonb,1)`,
    [WEBSITE, USER, JSON.stringify(originalEditorData)],
  );
  await pool.pool.query(
    `INSERT INTO website_revisions(id,"websiteId",revision,"editorData","performanceSettings","actorUserId") VALUES($1,$2,1,$3::jsonb,'{}'::jsonb,$4)`,
    [REVISION_ID, WEBSITE, JSON.stringify(originalEditorData), USER],
  );
}

async function cleanup() {
  await tenantTransaction(pool, TENANT, async (tx) => {
    await tx.query("DELETE FROM platform.outbox_deliveries WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.outbox_events WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.job_attempts WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.job_resources WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.jobs WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.memberships WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.tenants WHERE id=$1", [TENANT]);
  });
  await pool.pool.query("DELETE FROM site_releases WHERE \"websiteId\"=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM website_revisions WHERE \"websiteId\"=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM custom_code_snippets WHERE \"websiteId\"=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM theme_location_rules WHERE \"websiteId\"=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM websites WHERE id=$1", [WEBSITE]);
  await pool.pool.query("DELETE FROM users WHERE id=$1", [USER]);
}

async function setupJob() {
  await tenantTransaction(pool, TENANT, async (tx) => {
    await tx.query("INSERT INTO platform.tenants(id,name) VALUES($1,'Publish smoke tenant')", [TENANT]);
    await tx.query("INSERT INTO platform.memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [TENANT, USER]);
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const task = { schemaVersion: 1, jobId: JOB, tenantId: TENANT, jobType: "publish.build", deadline, traceId: TRACE };
    const event = { schemaVersion: 1,eventId: EVENT,tenantId: TENANT,aggregateId: JOB,aggregateVersion: 1,
      type: "site.lifecycle.v1",occurredAt: new Date().toISOString(),traceId: TRACE,
      payload: { action: "publish.smoke.requested", websiteId: WEBSITE, sourceRevision: 1, sourceHash } };
    await acceptJob(tx, { task,event,idempotencyKey: "publish-smoke-key-0001",payloadRef: `artifact:publish/${WEBSITE}/1`,sideEffects: "idempotent" });
    await tx.query(
      `INSERT INTO platform.job_resources(tenant_id,job_id,resource_type,resource_id,source_revision,source_hash,source_payload,requested_by)
       VALUES($1,$2,'WEBSITE_PUBLISH',$3,1,$4,$5::jsonb,$6)`,
      [TENANT, JOB, WEBSITE, sourceHash, JSON.stringify(sourcePayload), USER],
    );
  });
}

async function snapshot() {
  return tenantTransaction(pool, TENANT, async (tx) => {
    const result = await tx.query("SELECT state,attempt,result FROM platform.jobs WHERE tenant_id=$1 AND id=$2", [TENANT, JOB]);
    const pending = await tx.query("SELECT count(*)::int AS count FROM platform.outbox_deliveries WHERE tenant_id=$1 AND state='PENDING'", [TENANT]);
    return { job: result.rows[0], pending: Number(pending.rows[0]?.count || 0) };
  });
}

try {
  await pool.ping();
  await cleanup().catch(() => undefined);
  await createLegacyFixtures();
  await setupJob();

  // Mutating live draft/dependencies after acceptance must not change the release input.
  await pool.pool.query(`UPDATE websites SET "editorData"=$2::jsonb WHERE id=$1`, [WEBSITE, JSON.stringify({ version: 2, elements: [{ id: "heading", content: "MUTATED" }] })]);
  await pool.pool.query(
    `INSERT INTO custom_code_snippets("websiteId",name,language,code,priority,status,"isEnabled","isActive","isDraft")
     VALUES($1,'late-code','JS','console.log(1)',1,'PUBLISHED',true,true,false)`, [WEBSITE],
  );

  const abort = new AbortController();
  worker = await connectJobWorker("publish.build",new PublishAdapter(pool),pool,abort.signal,process.env,{ jobLeaseMs: 15_000 });
  rabbit = await connectRabbitPublisher(process.env);
  kafka = await connectKafkaPublisher(process.env);
  await worker.ping(); await rabbit.ping(); await kafka.ping();

  const rabbitStore = new PgOutboxStore(pool,TENANT,{ outboxLeaseMs: 10_000,outboxMaxAttempts: 4 });
  const kafkaStore = new PgOutboxStore(pool,TENANT,{ outboxLeaseMs: 10_000,outboxMaxAttempts: 4 });
  const timeoutAt = Date.now() + 20_000;
  let state;
  while (Date.now() < timeoutAt) {
    await relayBatch(rabbitStore,"rabbitmq",rabbit.publisher,16);
    await relayBatch(kafkaStore,"kafka",kafka.publisher,16);
    state = await snapshot();
    if (state.job?.state === "SUCCEEDED" && state.pending === 0) break;
    await pause(50);
  }
  assert.equal(state?.job?.state,"SUCCEEDED");
  assert.equal(Number(state.job.attempt),1);
  assert.match(String(state.job.result?.receipt),/^release:/);

  const releases = await pool.pool.query(
    `SELECT id,"releaseNumber","sourceRevision",status,payload FROM site_releases WHERE "websiteId"=$1 ORDER BY "releaseNumber"`, [WEBSITE],
  );
  assert.equal(releases.rowCount,1);
  assert.equal(releases.rows[0].status,"ACTIVE");
  assert.equal(Number(releases.rows[0].sourceRevision),1);
  assert.equal(releases.rows[0].payload.editorData.elements[0].content,"Verified release");
  assert.deepEqual(releases.rows[0].payload.customCodeSnippets,[]);

  const replay = await new PublishAdapter(pool).deliver(
    { tenantId: TENANT,jobId: JOB,idempotencyKey: "publish-smoke-key-0001",signal: new AbortController().signal },
    `artifact:publish/${WEBSITE}/1`,
  );
  assert.equal(replay.status,"DELIVERED");
  const releaseCount = await pool.pool.query("SELECT count(*)::int AS count FROM site_releases WHERE \"websiteId\"=$1", [WEBSITE]);
  assert.equal(Number(releaseCount.rows[0].count),1);

  // A delayed older intent must never replace a newer active release.
  await tenantTransaction(pool,TENANT,async (tx) => {
    await tx.query(
      `INSERT INTO platform.jobs(tenant_id,id,job_type,idempotency_key,request_hash,payload_ref,trace_id,deadline,state,side_effects)
       VALUES($1,$2,'publish.build','publish-smoke-key-0002',$3,$4,$5,clock_timestamp()+interval '1 minute','ACCEPTED','idempotent')`,
      [TENANT,JOB2,releaseContentHash({ jobId: JOB2 }),`artifact:publish/${WEBSITE}/1`,TRACE2],
    );
    await tx.query(
      `INSERT INTO platform.job_resources(tenant_id,job_id,resource_type,resource_id,source_revision,source_hash,source_payload,requested_by)
       VALUES($1,$2,'WEBSITE_PUBLISH',$3,1,$4,$5::jsonb,$6)`,
      [TENANT,JOB2,WEBSITE,sourceHash,JSON.stringify(sourcePayload),USER],
    );
  });
  await pause(20);
  const newerPayload = { ...sourcePayload, editorData: { version: 2, elements: [{ id: "heading", content: "Newer release" }] } };
  await pool.pool.query(`UPDATE site_releases SET status='RETIRED' WHERE "websiteId"=$1 AND status='ACTIVE'`, [WEBSITE]);
  await pool.pool.query(
    `INSERT INTO site_releases("websiteId","releaseNumber","sourceRevision","requestKey","requestHash","contentHash",payload,status,"createdBy","requestAcceptedAt","activatedAt")
     VALUES($1,2,2,'newer-intent',repeat('a',64),$2,$3::jsonb,'ACTIVE',$4,clock_timestamp(),clock_timestamp())`,
    [WEBSITE,releaseContentHash(newerPayload),JSON.stringify(newerPayload),USER],
  );
  const superseded = await new PublishAdapter(pool).deliver(
    { tenantId: TENANT,jobId: JOB2,idempotencyKey: "publish-smoke-key-0002",signal: new AbortController().signal },
    `artifact:publish/${WEBSITE}/1`,
  );
  assert.deepEqual(superseded,{ status: "FAILED_PERMANENTLY",code: "PUBLISH_SUPERSEDED" });
  const active = await pool.pool.query(`SELECT "sourceRevision",payload FROM site_releases WHERE "websiteId"=$1 AND status='ACTIVE'`, [WEBSITE]);
  assert.equal(Number(active.rows[0].sourceRevision),2);
  assert.equal(active.rows[0].payload.editorData.elements[0].content,"Newer release");

  console.log("PASS: immutable publish snapshot, outbox/broker lifecycle, idempotent replay and supersession fencing");
} finally {
  if (worker) await worker.close();
  if (rabbit) await rabbit.close();
  if (kafka) await kafka.close();
  try { await cleanup(); } finally { await pool.close(); }
}
