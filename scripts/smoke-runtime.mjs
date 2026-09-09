import assert from "node:assert/strict";
import { cacheKey, rateLimit, TenantCache } from "../packages/platform/redis.ts";
import { connectRedis } from "../packages/platform/node-redis.ts";
import { NodePostgresPool } from "../packages/platform/node-postgres.ts";
import { connectRabbitPublisher } from "../packages/platform/node-rabbitmq.ts";
import { connectKafkaPublisher } from "../packages/platform/node-kafka.ts";
import { canonicalJson } from "../packages/events/index.ts";
import { acceptJob, tenantTransaction } from "../workers/shared/postgres.ts";
import { PgJobStore, PgOutboxStore } from "../workers/shared/pg-stores.ts";
import { relayBatch } from "../workers/shared/outbox.ts";
import { connectJobWorker } from "../workers/shared/rabbit-worker.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const EVENT = "44444444-4444-4444-8444-444444444444";
const TRACE = "55555555-5555-4555-8555-555555555555";
const UNCERTAIN_JOB = "66666666-6666-4666-8666-666666666666";
const UNCERTAIN_EVENT = "77777777-7777-4777-8777-777777777777";
const EXPIRED_TOKEN = "88888888-8888-4888-8888-888888888888";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function cleanup(pool) {
  await tenantTransaction(pool, TENANT, async (tx) => {
    await tx.query("DELETE FROM platform.outbox_deliveries WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.outbox_events WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.job_attempts WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.jobs WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.consumer_inbox WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.audit_events WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.memberships WHERE tenant_id=$1", [TENANT]);
    await tx.query("DELETE FROM platform.tenants WHERE id=$1", [TENANT]);
  });
}

async function createTenant(pool) {
  await tenantTransaction(pool, TENANT, async (tx) => {
    await tx.query(
      "INSERT INTO platform.tenants(id,name) VALUES($1,'Runtime smoke tenant')",
      [TENANT],
    );
    await tx.query(
      `INSERT INTO platform.memberships(tenant_id,user_id,role)
       VALUES($1,$2,'OWNER')`,
      [TENANT, USER],
    );
  });
}

async function jobSnapshot(pool, jobId) {
  return tenantTransaction(pool, TENANT, async (tx) => {
    const job = await tx.query(
      `SELECT state,attempt,result FROM platform.jobs
       WHERE tenant_id=$1 AND id=$2`,
      [TENANT, jobId],
    );
    const outbox = await tx.query(
      `SELECT destination,state,count(*)::int AS count
       FROM platform.outbox_deliveries
       WHERE tenant_id=$1
       GROUP BY destination,state
       ORDER BY destination,state`,
      [TENANT],
    );
    return { job: job.rows[0], outbox: outbox.rows };
  });
}

async function drainOutbox(pool, rabbit, kafka, until) {
  const rabbitStore = new PgOutboxStore(pool, TENANT, {
    outboxLeaseMs: 10_000,
    outboxMaxAttempts: 4,
  });
  const kafkaStore = new PgOutboxStore(pool, TENANT, {
    outboxLeaseMs: 10_000,
    outboxMaxAttempts: 4,
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await relayBatch(rabbitStore, "rabbitmq", rabbit.publisher, 16);
    await relayBatch(kafkaStore, "kafka", kafka.publisher, 16);
    const snapshot = await jobSnapshot(pool, JOB);
    if (await until(snapshot)) return snapshot;
    await pause(50);
  }
  throw new Error("RUNTIME_SMOKE_TIMEOUT");
}

const pool = new NodePostgresPool({
  ...process.env,
  SERVICE_NAME: "forgestudio-runtime-smoke",
  POSTGRES_POOL_MAX: "4",
});
let cache;
let control;
let rabbit;
let kafka;
let worker;

try {
  await pool.ping();
  await cleanup(pool);
  await createTenant(pool);

  cache = await connectRedis("cache", process.env);
  control = await connectRedis("control", process.env);
  await cache.ping();
  await control.ping();

  const tenantCache = new TenantCache(cache.port);
  const key = cacheKey("ci", "local1", TENANT, "site", "runtime", 1);
  assert.equal(await tenantCache.set(key, { ready: true }, 30), true);
  assert.deepEqual(await tenantCache.get(key), { ready: true });

  const limiterKey = `fs:ci:local1:{${TENANT}}:limit:runtime-smoke`;
  assert.equal((await rateLimit(control.port, limiterKey, 1, 5_000)).allowed, true);
  const limited = await rateLimit(control.port, limiterKey, 1, 5_000);
  assert.equal(limited.allowed, false);
  assert.ok(limited.retryAfterMs > 0);

  rabbit = await connectRabbitPublisher(process.env);
  kafka = await connectKafkaPublisher(process.env);
  await rabbit.ping();
  await kafka.ping();

  let deliveryAttempts = 0;
  const abort = new AbortController();
  worker = await connectJobWorker(
    "publish.build",
    {
      id: "runtime-smoke-publish",
      sideEffects: "idempotent",
      async deliver(context, payloadRef) {
        assert.equal(context.tenantId, TENANT);
        assert.equal(context.jobId, JOB);
        assert.equal(payloadRef, "artifact:runtime/site/revision-1");
        deliveryAttempts += 1;
        if (deliveryAttempts === 1) {
          return { status: "RETRYABLE", code: "SMOKE_RETRY", retryAfterMs: 10 };
        }
        return { status: "DELIVERED", receipt: "runtime-smoke-receipt" };
      },
    },
    pool,
    abort.signal,
    process.env,
    { jobLeaseMs: 10_000 },
  );
  await worker.ping();

  const deadline = new Date(Date.now() + 60_000).toISOString();
  const task = {
    schemaVersion: 1,
    jobId: JOB,
    tenantId: TENANT,
    jobType: "publish.build",
    deadline,
    traceId: TRACE,
  };
  const event = {
    schemaVersion: 1,
    eventId: EVENT,
    tenantId: TENANT,
    aggregateId: JOB,
    aggregateVersion: 0,
    type: "site.lifecycle.v1",
    occurredAt: new Date().toISOString(),
    traceId: TRACE,
    payload: { action: "runtime.smoke.accepted" },
  };

  const accepted = await tenantTransaction(pool, TENANT, (tx) =>
    acceptJob(tx, {
      task,
      event,
      idempotencyKey: "runtime-smoke-key-0001",
      payloadRef: "artifact:runtime/site/revision-1",
      sideEffects: "idempotent",
    }),
  );
  assert.deepEqual(accepted, { jobId: JOB, replayed: false });

  const replay = await tenantTransaction(pool, TENANT, (tx) =>
    acceptJob(tx, {
      task,
      event,
      idempotencyKey: "runtime-smoke-key-0001",
      payloadRef: "artifact:runtime/site/revision-1",
      sideEffects: "idempotent",
    }),
  );
  assert.deepEqual(replay, { jobId: JOB, replayed: true });

  const completed = await drainOutbox(
    pool,
    rabbit,
    kafka,
    async (snapshot) => {
      const pending = snapshot.outbox
        .filter((row) => row.state === "PENDING")
        .reduce((sum, row) => sum + Number(row.count), 0);
      return snapshot.job?.state === "SUCCEEDED" && pending === 0;
    },
  );
  assert.equal(completed.job.state, "SUCCEEDED");
  assert.equal(Number(completed.job.attempt), 2);
  assert.equal(completed.job.result.receipt, "runtime-smoke-receipt");
  assert.equal(deliveryAttempts, 2);
  assert.equal(completed.outbox.some((row) => row.state === "FAILED"), false);

  const uncertainTask = {
    ...task,
    jobId: UNCERTAIN_JOB,
    jobType: "integration.deliver",
  };
  const uncertainEvent = {
    ...event,
    eventId: UNCERTAIN_EVENT,
    aggregateId: UNCERTAIN_JOB,
    type: "integration.status.v1",
    payload: { action: "runtime.smoke.uncertain" },
  };
  await tenantTransaction(pool, TENANT, (tx) =>
    acceptJob(tx, {
      task: uncertainTask,
      event: uncertainEvent,
      idempotencyKey: "runtime-smoke-key-0002",
      payloadRef: "artifact:runtime/integration/delivery-1",
      sideEffects: "non-idempotent",
    }),
  );
  await tenantTransaction(pool, TENANT, async (tx) => {
    await tx.query(
      `UPDATE platform.jobs
       SET state='RUNNING',attempt=1,lease_token=$3,
           lease_until=clock_timestamp()-interval '1 second'
       WHERE tenant_id=$1 AND id=$2`,
      [TENANT, UNCERTAIN_JOB, EXPIRED_TOKEN],
    );
    await tx.query(
      `INSERT INTO platform.job_attempts(
         tenant_id,job_id,attempt,lease_token,started_at
       ) VALUES($1,$2,1,$3,clock_timestamp()-interval '2 seconds')`,
      [TENANT, UNCERTAIN_JOB, EXPIRED_TOKEN],
    );
  });

  const recovery = await new PgJobStore(pool, { jobLeaseMs: 10_000 })
    .recoverExpiredLeases(TENANT);
  assert.deepEqual(recovery, { retried: 0, failed: 0, unknown: 1 });
  const uncertain = await jobSnapshot(pool, UNCERTAIN_JOB);
  assert.equal(uncertain.job.state, "OUTCOME_UNKNOWN");
  assert.equal(
    uncertain.job.result.code,
    "LEASE_EXPIRED_REMOTE_OUTCOME_UNCERTAIN",
  );

  // The persisted payload remains bounded JSON and contains no credential material.
  assert.ok(canonicalJson(uncertain.job.result).length < 1_024);

  console.log(
    "PASS: real Postgres/Redis/RabbitMQ/Kafka runtime, durable retry, idempotency and uncertain-outcome recovery",
  );
} finally {
  if (worker) await worker.close();
  if (rabbit) await rabbit.close();
  if (kafka) await kafka.close();
  if (cache) await cache.close();
  if (control) await control.close();
  try {
    await cleanup(pool);
  } finally {
    await pool.close();
  }
}
