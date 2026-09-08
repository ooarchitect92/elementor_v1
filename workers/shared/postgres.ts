import { canonicalJson, fingerprint, uuid, parseTask, parseEvent } from '../../packages/events/index.ts';
import type { TaskEnvelope, EventEnvelope } from '../../packages/events/index.ts';
export interface SqlConnection {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{rows: T[]; rowCount: number | null}>;
  release(destroy?: boolean): void;
}
export interface SqlPool {connect(): Promise<SqlConnection>}
/** Use a non-owner, non-BYPASSRLS application role. SET LOCAL cannot leak through a pool. */
export async function tenantTransaction<T>(pool: SqlPool, tenantId: string, fn: (tx: SqlConnection) => Promise<T>): Promise<T> {
  const tenant = uuid(tenantId); const connection = await pool.connect();
  let destroy = false;
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await fn(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try { await connection.query('ROLLBACK'); } catch { destroy = true; }
    throw error;
  } finally { connection.release(destroy); }
}
export interface AcceptJobInput {task: TaskEnvelope; event: EventEnvelope; idempotencyKey: string; payloadRef: string}
/** Call inside tenantTransaction AFTER authoritative membership/entitlement checks. */
export async function acceptJob(tx: SqlConnection, input: AcceptJobInput): Promise<{jobId: string; replayed: boolean}> {
  const task = parseTask(input.task); const event = parseEvent(input.event);
  if (task.tenantId !== event.tenantId || event.aggregateId !== task.jobId) throw new Error('SCOPE_MISMATCH');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey) || !/^artifact:[A-Za-z0-9/_-]{1,240}$/.test(input.payloadRef)) throw new Error('INVALID_JOB_INPUT');
  // Excludes generated IDs/deadline/trace; the same logical payload has one stable receipt.
  const hash = await fingerprint({jobType: task.jobType, payloadRef: input.payloadRef});
  const inserted = await tx.query<{id: string}>(
    `INSERT INTO platform.jobs(tenant_id,id,job_type,idempotency_key,request_hash,payload_ref,deadline,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,'ACCEPTED') ON CONFLICT(tenant_id,job_type,idempotency_key) DO NOTHING RETURNING id`,
    [task.tenantId, task.jobId, task.jobType, input.idempotencyKey, hash, input.payloadRef, task.deadline]);
  if (!inserted.rows.length) {
    const existing = await tx.query<{id: string; request_hash: string}>(
      'SELECT id,request_hash FROM platform.jobs WHERE tenant_id=$1 AND job_type=$2 AND idempotency_key=$3', [task.tenantId,task.jobType,input.idempotencyKey]);
    const row = existing.rows[0];
    if (!row || row.request_hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
    return {jobId: row.id, replayed: true};
  }
  await tx.query('INSERT INTO platform.outbox_events(tenant_id,event_id,aggregate_id,aggregate_version,event_type,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [event.tenantId,event.eventId,event.aggregateId,event.aggregateVersion,event.type,canonicalJson(event)]);
  await tx.query(`INSERT INTO platform.outbox_deliveries(tenant_id,event_id,destination,body) VALUES($1,$2,'rabbitmq',$3::jsonb),($1,$2,'kafka',$4::jsonb)`, [task.tenantId,event.eventId,canonicalJson(task),canonicalJson(event)]);
  return {jobId: task.jobId, replayed: false};
}
