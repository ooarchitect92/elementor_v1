import {
  canonicalJson,
  parseTask,
  uuid,
  type Destination,
  type EventEnvelope,
  type Json,
  type JobType,
  type TaskEnvelope,
} from "../../packages/events/index.ts";
import {
  retryDelay,
  type DeliveryOutcome,
} from "../../packages/adapter-sdk/index.ts";
import type { JobState } from "../../packages/platform/jobs.ts";
import type { JobLease, JobStore } from "./worker.ts";
import type { OutboxClaim, OutboxStore } from "./outbox.ts";
import {
  tenantTransaction,
  type SqlConnection,
  type SqlPool,
} from "./postgres.ts";

type SideEffects = "none" | "idempotent" | "non-idempotent";

interface JobRow {
  tenant_id: string;
  id: string;
  job_type: JobType;
  idempotency_key: string;
  payload_ref: string;
  trace_id: string;
  state: JobState;
  side_effects: SideEffects;
  attempt: number | string;
  max_attempts: number | string;
  available_at: Date | string;
  deadline: Date | string;
  lease_token: string | null;
  lease_until: Date | string | null;
  db_now?: Date | string;
}

interface OutboxRow {
  tenant_id: string;
  event_id: string;
  destination: Destination;
  lease_token: string;
  lease_until: Date | string;
  attempt: number | string;
  body: unknown;
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_DATABASE_TIMESTAMP");
  return date;
}

function databaseNow(row: JobRow): Date {
  if (!row.db_now) throw new Error("DATABASE_CLOCK_MISSING");
  return asDate(row.db_now);
}

function asInteger(value: number | string, code: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function boundedReceipt(value: string): string {
  const receipt = value.trim();
  if (!receipt || new TextEncoder().encode(receipt).byteLength > 1_024) {
    throw new Error("INVALID_DELIVERY_RECEIPT");
  }
  return receipt;
}

function boundedCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9_.:-]{1,80}$/.test(code)) return "UNCLASSIFIED_FAILURE";
  return code;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("INVALID_OUTBOX_JSON");
  }
}

function terminal(state: JobState): boolean {
  return ["SUCCEEDED", "FAILED_PERMANENTLY", "OUTCOME_UNKNOWN", "CANCELLED"].includes(state);
}

interface JobEventInput {
  row: JobRow;
  state: JobState;
  code?: string | undefined;
  receipt?: string | undefined;
  retryAt?: Date | undefined;
}

async function emitJobEvent(
  tx: SqlConnection,
  input: JobEventInput,
): Promise<void> {
  const eventId = crypto.randomUUID();
  const attempt = asInteger(input.row.attempt, "INVALID_JOB_ATTEMPT");
  const payload: Record<string, Json> = {
    state: input.state,
    jobType: input.row.job_type,
    attempt,
  };
  if (input.code) payload.code = boundedCode(input.code);
  if (input.receipt) payload.receipt = input.receipt.slice(0, 512);
  if (input.retryAt) payload.retryAt = input.retryAt.toISOString();

  const event: EventEnvelope = {
    schemaVersion: 1,
    eventId,
    tenantId: input.row.tenant_id,
    aggregateId: input.row.id,
    aggregateVersion: attempt,
    type: "integration.status.v1",
    occurredAt: new Date().toISOString(),
    traceId: input.row.trace_id,
    payload,
  };

  await tx.query(
    `INSERT INTO platform.outbox_events(
       tenant_id,event_id,aggregate_id,aggregate_version,event_type,body
     ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      event.tenantId,
      event.eventId,
      event.aggregateId,
      event.aggregateVersion,
      event.type,
      canonicalJson(event),
    ],
  );
  await tx.query(
    `INSERT INTO platform.outbox_deliveries(
       tenant_id,event_id,destination,body
     ) VALUES($1,$2,'kafka',$3::jsonb)`,
    [event.tenantId, event.eventId, canonicalJson(event)],
  );

  if (input.state === "RETRY_SCHEDULED") {
    const task: TaskEnvelope = {
      schemaVersion: 1,
      jobId: input.row.id,
      tenantId: input.row.tenant_id,
      jobType: input.row.job_type,
      deadline: asDate(input.row.deadline).toISOString(),
      traceId: input.row.trace_id,
    };
    if (!input.retryAt) throw new Error("RETRY_TIME_REQUIRED");
    await tx.query(
      `INSERT INTO platform.outbox_deliveries(
         tenant_id,event_id,destination,body,available_at
       ) VALUES($1,$2,'rabbitmq',$3::jsonb,$4::timestamptz)`,
      [
        event.tenantId,
        event.eventId,
        canonicalJson(task),
        input.retryAt.toISOString(),
      ],
    );
  }
}

export interface PgStoreOptions {
  jobLeaseMs?: number;
  outboxLeaseMs?: number;
  outboxMaxAttempts?: number;
}

function option(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(code);
  }
  return selected;
}

export class PgJobStore implements JobStore {
  private readonly leaseMs: number;

  constructor(
    private readonly pool: SqlPool,
    options: PgStoreOptions = {},
  ) {
    this.leaseMs = option(options.jobLeaseMs, 60_000, 1_000, 15 * 60_000, "INVALID_JOB_LEASE");
  }

  async claim(taskInput: TaskEnvelope): Promise<JobLease | null> {
    const task = parseTask(taskInput);
    return tenantTransaction(this.pool, task.tenantId, async (tx) => {
      const selected = await tx.query<JobRow>(
        `SELECT tenant_id,id,job_type,idempotency_key,payload_ref,trace_id,state,
                side_effects,attempt,max_attempts,available_at,deadline,
                lease_token,lease_until,clock_timestamp() AS db_now
         FROM platform.jobs
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [task.tenantId, task.jobId],
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (
        row.tenant_id !== task.tenantId ||
        row.job_type !== task.jobType ||
        row.trace_id !== task.traceId ||
        asDate(row.deadline).getTime() !== Date.parse(task.deadline)
      ) {
        throw new Error("TASK_JOB_MISMATCH");
      }
      if (terminal(row.state)) return null;

      const now = databaseNow(row);
      let attempt = asInteger(row.attempt, "INVALID_JOB_ATTEMPT");
      const maxAttempts = asInteger(row.max_attempts, "INVALID_MAX_ATTEMPTS");

      if (row.state === "RUNNING") {
        const leaseUntil = row.lease_until ? asDate(row.lease_until) : null;
        if (leaseUntil && leaseUntil.getTime() > now.getTime()) return null;

        if (row.side_effects === "non-idempotent") {
          await tx.query(
            `UPDATE platform.jobs
             SET state='OUTCOME_UNKNOWN',lease_token=NULL,lease_until=NULL,
                 result=$3::jsonb,updated_at=clock_timestamp()
             WHERE tenant_id=$1 AND id=$2`,
            [
              row.tenant_id,
              row.id,
              canonicalJson({
                status: "OUTCOME_UNKNOWN",
                code: "LEASE_EXPIRED_REMOTE_OUTCOME_UNCERTAIN",
              }),
            ],
          );
          const completedAttempt = await tx.query(
            `UPDATE platform.job_attempts
             SET completed_at=clock_timestamp(),outcome='OUTCOME_UNKNOWN',
                 error_code='LEASE_EXPIRED_REMOTE_OUTCOME_UNCERTAIN'
             WHERE tenant_id=$1 AND job_id=$2 AND attempt=$3
               AND completed_at IS NULL`,
            [row.tenant_id, row.id, attempt],
          );
          if (completedAttempt.rowCount !== 1) throw new Error("JOB_ATTEMPT_MISSING");
          await emitJobEvent(tx, {
            row,
            state: "OUTCOME_UNKNOWN",
            code: "LEASE_EXPIRED_REMOTE_OUTCOME_UNCERTAIN",
          });
          return null;
        }

        const completedAttempt = await tx.query(
          `UPDATE platform.job_attempts
           SET completed_at=clock_timestamp(),outcome='RETRYABLE',
               error_code='LEASE_EXPIRED'
           WHERE tenant_id=$1 AND job_id=$2 AND attempt=$3
             AND completed_at IS NULL`,
          [row.tenant_id, row.id, attempt],
        );
        if (completedAttempt.rowCount !== 1) throw new Error("JOB_ATTEMPT_MISSING");
      } else if (!["ACCEPTED", "QUEUED", "RETRY_SCHEDULED"].includes(row.state)) {
        throw new Error("INVALID_JOB_STATE");
      }

      if (
        asDate(row.available_at).getTime() > now.getTime() ||
        (row.lease_until && asDate(row.lease_until).getTime() > now.getTime())
      ) {
        return null;
      }

      if (asDate(row.deadline).getTime() <= now.getTime() || attempt >= maxAttempts) {
        const code = asDate(row.deadline).getTime() <= now.getTime()
          ? "JOB_DEADLINE_EXCEEDED"
          : "JOB_ATTEMPTS_EXHAUSTED";
        await tx.query(
          `UPDATE platform.jobs
           SET state='FAILED_PERMANENTLY',lease_token=NULL,lease_until=NULL,
               result=$3::jsonb,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND id=$2`,
          [
            row.tenant_id,
            row.id,
            canonicalJson({ status: "FAILED_PERMANENTLY", code }),
          ],
        );
        await emitJobEvent(tx, { row, state: "FAILED_PERMANENTLY", code });
        return null;
      }

      attempt += 1;
      const token = crypto.randomUUID();
      const updated = await tx.query<{ lease_until: Date | string }>(
        `UPDATE platform.jobs
         SET state='RUNNING',attempt=$3,lease_token=$4,
             lease_until=clock_timestamp()+($5::integer * interval '1 millisecond'),
             updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2
         RETURNING lease_until`,
        [row.tenant_id, row.id, attempt, token, this.leaseMs],
      );
      if (!updated.rows[0]) throw new Error("JOB_CLAIM_FAILED");

      await tx.query(
        `INSERT INTO platform.job_attempts(
           tenant_id,job_id,attempt,lease_token
         ) VALUES($1,$2,$3,$4)`,
        [row.tenant_id, row.id, attempt, token],
      );

      return {
        tenantId: row.tenant_id,
        jobId: row.id,
        token,
        payloadRef: row.payload_ref,
        idempotencyKey: row.idempotency_key,
        jobType: row.job_type,
        deadline: asDate(row.deadline).toISOString(),
        traceId: row.trace_id,
        attempt,
        maxAttempts,
        sideEffects: row.side_effects,
      };
    });
  }

  async complete(lease: JobLease, outcome: DeliveryOutcome): Promise<boolean> {
    uuid(lease.tenantId);
    uuid(lease.jobId);
    uuid(lease.token);
    uuid(lease.traceId);

    return tenantTransaction(this.pool, lease.tenantId, async (tx) => {
      const selected = await tx.query<JobRow>(
        `SELECT tenant_id,id,job_type,idempotency_key,payload_ref,trace_id,state,
                side_effects,attempt,max_attempts,available_at,deadline,
                lease_token,lease_until,clock_timestamp() AS db_now
         FROM platform.jobs
         WHERE tenant_id=$1 AND id=$2
         FOR UPDATE`,
        [lease.tenantId, lease.jobId],
      );
      const row = selected.rows[0];
      if (
        !row ||
        row.state !== "RUNNING" ||
        row.lease_token !== lease.token ||
        !row.lease_until ||
        asDate(row.lease_until).getTime() <= databaseNow(row).getTime()
      ) {
        return false;
      }
      if (
        row.job_type !== lease.jobType ||
        row.trace_id !== lease.traceId ||
        row.payload_ref !== lease.payloadRef ||
        row.idempotency_key !== lease.idempotencyKey ||
        row.side_effects !== lease.sideEffects ||
        asDate(row.deadline).getTime() !== Date.parse(lease.deadline) ||
        asInteger(row.attempt, "INVALID_JOB_ATTEMPT") !== lease.attempt ||
        asInteger(row.max_attempts, "INVALID_MAX_ATTEMPTS") !== lease.maxAttempts
      ) {
        throw new Error("LEASE_JOB_MISMATCH");
      }

      const now = databaseNow(row);
      const attempt = asInteger(row.attempt, "INVALID_JOB_ATTEMPT");
      const maxAttempts = asInteger(row.max_attempts, "INVALID_MAX_ATTEMPTS");
      let state: JobState;
      let code: string | undefined;
      let receipt: string | undefined;
      let retryAt: Date | undefined;
      let persistedOutcome: DeliveryOutcome = outcome;

      if (outcome.status === "DELIVERED") {
        state = "SUCCEEDED";
        receipt = boundedReceipt(outcome.receipt);
      } else if (outcome.status === "FAILED_PERMANENTLY") {
        state = "FAILED_PERMANENTLY";
        code = boundedCode(outcome.code);
      } else if (outcome.status === "OUTCOME_UNKNOWN") {
        state = "OUTCOME_UNKNOWN";
        code = boundedCode(outcome.code);
      } else {
        code = boundedCode(outcome.code);
        const delay = retryDelay(
          attempt,
          Math.random,
          outcome.retryAfterMs ?? 0,
        );
        retryAt = new Date(now.getTime() + delay);
        if (
          attempt >= maxAttempts ||
          retryAt.getTime() >= asDate(row.deadline).getTime()
        ) {
          state = "FAILED_PERMANENTLY";
          code = attempt >= maxAttempts
            ? "JOB_ATTEMPTS_EXHAUSTED"
            : "JOB_DEADLINE_EXCEEDED";
          retryAt = undefined;
          persistedOutcome = { status: "FAILED_PERMANENTLY", code };
        } else {
          state = "RETRY_SCHEDULED";
        }
      }

      const result: Record<string, Json> = { status: persistedOutcome.status };
      if (code) result.code = code;
      if (receipt) result.receipt = receipt;
      if (retryAt) result.retryAt = retryAt.toISOString();

      const updated = await tx.query(
        `UPDATE platform.jobs
         SET state=$3,available_at=COALESCE($4::timestamptz,available_at),
             lease_token=NULL,lease_until=NULL,result=$5::jsonb,
             updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND state='RUNNING' AND lease_token=$6
           AND lease_until>clock_timestamp()`,
        [
          row.tenant_id,
          row.id,
          state,
          retryAt?.toISOString() ?? null,
          canonicalJson(result),
          lease.token,
        ],
      );
      if (updated.rowCount !== 1) return false;

      const completedAttempt = await tx.query(
        `UPDATE platform.job_attempts
         SET completed_at=clock_timestamp(),outcome=$4,error_code=$5
         WHERE tenant_id=$1 AND job_id=$2 AND attempt=$3 AND lease_token=$6
           AND completed_at IS NULL`,
        [
          row.tenant_id,
          row.id,
          attempt,
          persistedOutcome.status,
          code ?? null,
          lease.token,
        ],
      );
      if (completedAttempt.rowCount !== 1) throw new Error("JOB_ATTEMPT_MISSING");
      await emitJobEvent(tx, { row, state, code, receipt, retryAt });
      return true;
    });
  }

  async recoverExpiredLeases(
    tenantId: string,
    limit = 100,
  ): Promise<{ retried: number; failed: number; unknown: number }> {
    const tenant = uuid(tenantId);
    const boundedLimit = option(limit, 100, 1, 500, "INVALID_RECOVERY_LIMIT");

    return tenantTransaction(this.pool, tenant, async (tx) => {
      const selected = await tx.query<JobRow>(
        `SELECT tenant_id,id,job_type,idempotency_key,payload_ref,trace_id,state,
                side_effects,attempt,max_attempts,available_at,deadline,
                lease_token,lease_until,clock_timestamp() AS db_now
         FROM platform.jobs
         WHERE tenant_id=$1 AND state='RUNNING'
           AND lease_until<=clock_timestamp()
         ORDER BY lease_until,id
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [tenant, boundedLimit],
      );

      let retried = 0;
      let failed = 0;
      let unknown = 0;
      for (const row of selected.rows) {
        const attempt = asInteger(row.attempt, "INVALID_JOB_ATTEMPT");
        const maxAttempts = asInteger(row.max_attempts, "INVALID_MAX_ATTEMPTS");
        let state: JobState;
        let code: string;

        if (row.side_effects === "non-idempotent") {
          state = "OUTCOME_UNKNOWN";
          code = "LEASE_EXPIRED_REMOTE_OUTCOME_UNCERTAIN";
          unknown += 1;
        } else if (
          attempt >= maxAttempts ||
          asDate(row.deadline).getTime() <= databaseNow(row).getTime()
        ) {
          state = "FAILED_PERMANENTLY";
          code = attempt >= maxAttempts
            ? "JOB_ATTEMPTS_EXHAUSTED"
            : "JOB_DEADLINE_EXCEEDED";
          failed += 1;
        } else {
          state = "RETRY_SCHEDULED";
          code = "LEASE_EXPIRED";
          retried += 1;
        }

        await tx.query(
          `UPDATE platform.jobs
           SET state=$3,available_at=CASE WHEN $3='RETRY_SCHEDULED'
             THEN clock_timestamp() ELSE available_at END,
             lease_token=NULL,lease_until=NULL,result=$4::jsonb,
             updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND id=$2`,
          [
            row.tenant_id,
            row.id,
            state,
            canonicalJson({ status: state, code }),
          ],
        );
        const completedAttempt = await tx.query(
          `UPDATE platform.job_attempts
           SET completed_at=clock_timestamp(),outcome=$4,error_code=$5
           WHERE tenant_id=$1 AND job_id=$2 AND attempt=$3
             AND completed_at IS NULL`,
          [row.tenant_id, row.id, attempt, state, code],
        );
        if (completedAttempt.rowCount !== 1) throw new Error("JOB_ATTEMPT_MISSING");
        await emitJobEvent(tx, {
          row,
          state,
          code,
          retryAt: state === "RETRY_SCHEDULED" ? databaseNow(row) : undefined,
        });
      }

      return { retried, failed, unknown };
    });
  }
}

export class PgOutboxStore implements OutboxStore {
  private readonly tenantId: string;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly pool: SqlPool,
    tenantId: string,
    options: PgStoreOptions = {},
  ) {
    this.tenantId = uuid(tenantId);
    this.leaseMs = option(
      options.outboxLeaseMs,
      30_000,
      1_000,
      5 * 60_000,
      "INVALID_OUTBOX_LEASE",
    );
    this.maxAttempts = option(
      options.outboxMaxAttempts,
      12,
      1,
      100,
      "INVALID_OUTBOX_ATTEMPTS",
    );
  }

  async claim(destination: Destination, limit: number): Promise<OutboxClaim[]> {
    if (!["rabbitmq", "kafka"].includes(destination)) {
      throw new Error("INVALID_OUTBOX_DESTINATION");
    }
    const boundedLimit = option(limit, 32, 1, 128, "INVALID_BATCH_SIZE");

    return tenantTransaction(this.pool, this.tenantId, async (tx) => {
      const claimed = await tx.query<OutboxRow>(
        `WITH due AS (
           SELECT tenant_id,event_id,destination
           FROM platform.outbox_deliveries
           WHERE tenant_id=$1 AND destination=$2 AND state='PENDING'
             AND available_at<=clock_timestamp()
             AND (lease_until IS NULL OR lease_until<=clock_timestamp())
           ORDER BY available_at,event_id
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE platform.outbox_deliveries AS delivery
         SET lease_token=gen_random_uuid(),
             lease_until=clock_timestamp()+($4::integer * interval '1 millisecond')
         FROM due
         WHERE delivery.tenant_id=due.tenant_id
           AND delivery.event_id=due.event_id
           AND delivery.destination=due.destination
         RETURNING delivery.tenant_id,delivery.event_id,delivery.destination,
                   delivery.lease_token,delivery.lease_until,
                   delivery.attempt,delivery.body`,
        [this.tenantId, destination, boundedLimit, this.leaseMs],
      );

      return claimed.rows.map((row) => ({
        tenantId: row.tenant_id,
        eventId: row.event_id,
        destination: row.destination,
        leaseToken: row.lease_token,
        leaseExpiresAt: asDate(row.lease_until).toISOString(),
        attempt: asInteger(row.attempt, "INVALID_OUTBOX_ATTEMPT"),
        body: jsonValue(row.body),
      }));
    });
  }

  async markSent(claim: OutboxClaim): Promise<boolean> {
    if (
      uuid(claim.tenantId) !== this.tenantId ||
      !["rabbitmq", "kafka"].includes(claim.destination)
    ) {
      throw new Error("OUTBOX_CLAIM_SCOPE_MISMATCH");
    }

    return tenantTransaction(this.pool, this.tenantId, async (tx) => {
      const updated = await tx.query(
        `UPDATE platform.outbox_deliveries
         SET state='SENT',sent_at=clock_timestamp(),lease_token=NULL,
             lease_until=NULL,error_code=NULL
         WHERE tenant_id=$1 AND event_id=$2 AND destination=$3
           AND state='PENDING' AND lease_token=$4
           AND lease_until>clock_timestamp()`,
        [
          claim.tenantId,
          uuid(claim.eventId),
          claim.destination,
          uuid(claim.leaseToken),
        ],
      );
      if (updated.rowCount !== 1) return false;

      if (claim.destination === "rabbitmq") {
        const task = parseTask(claim.body);
        await tx.query(
          `UPDATE platform.jobs
           SET state=CASE WHEN state='ACCEPTED' THEN 'QUEUED' ELSE state END,
               updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND id=$2`,
          [task.tenantId, task.jobId],
        );
      }
      return true;
    });
  }

  async retry(claim: OutboxClaim, codeInput: string): Promise<boolean> {
    if (uuid(claim.tenantId) !== this.tenantId) {
      throw new Error("OUTBOX_CLAIM_SCOPE_MISMATCH");
    }
    const code = boundedCode(codeInput);
    const nextAttempt = claim.attempt + 1;
    const final = nextAttempt >= this.maxAttempts;
    const delay = final ? 0 : retryDelay(Math.max(1, nextAttempt));

    return tenantTransaction(this.pool, this.tenantId, async (tx) => {
      const updated = await tx.query(
        `UPDATE platform.outbox_deliveries
         SET state=$5,attempt=attempt+1,
             available_at=clock_timestamp()+($6::integer * interval '1 millisecond'),
             lease_token=NULL,lease_until=NULL,error_code=$7
         WHERE tenant_id=$1 AND event_id=$2 AND destination=$3
           AND state='PENDING' AND lease_token=$4
           AND lease_until>clock_timestamp()`,
        [
          claim.tenantId,
          uuid(claim.eventId),
          claim.destination,
          uuid(claim.leaseToken),
          final ? "FAILED" : "PENDING",
          delay,
          code,
        ],
      );
      if (updated.rowCount !== 1) return false;

      if (final && claim.destination === "rabbitmq") {
        const task = parseTask(claim.body);
        const jobs = await tx.query<JobRow>(
          `SELECT tenant_id,id,job_type,idempotency_key,payload_ref,trace_id,state,
                  side_effects,attempt,max_attempts,available_at,deadline,
                  lease_token,lease_until
           FROM platform.jobs
           WHERE tenant_id=$1 AND id=$2
           FOR UPDATE`,
          [task.tenantId, task.jobId],
        );
        const row = jobs.rows[0];
        if (row && ["ACCEPTED", "QUEUED", "RETRY_SCHEDULED"].includes(row.state)) {
          const failureCode = "TASK_PUBLICATION_EXHAUSTED";
          await tx.query(
            `UPDATE platform.jobs
             SET state='FAILED_PERMANENTLY',result=$3::jsonb,
                 lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
             WHERE tenant_id=$1 AND id=$2`,
            [
              row.tenant_id,
              row.id,
              canonicalJson({
                status: "FAILED_PERMANENTLY",
                code: failureCode,
              }),
            ],
          );
          await emitJobEvent(tx, {
            row,
            state: "FAILED_PERMANENTLY",
            code: failureCode,
          });
        }
      }
      return true;
    });
  }
}
