export type DeliveryOutcome =
  | {status: 'DELIVERED'; receipt: string}
  | {status: 'RETRYABLE'; code: string; retryAfterMs?: number}
  | {status: 'FAILED_PERMANENTLY'; code: string}
  | {status: 'OUTCOME_UNKNOWN'; code: string};
export interface DeliveryContext {
  tenantId: string;
  jobId: string;
  /** Stable across attempts; not the lease token. */
  idempotencyKey: string;
  signal: AbortSignal;
}
export interface Adapter {
  readonly id: string;
  readonly sideEffects: 'none' | 'idempotent' | 'non-idempotent';
  deliver(context: DeliveryContext, payloadRef: string): Promise<DeliveryOutcome>;
}
/** Bounded full jitter. Production callers must also enforce max attempts/deadline. */
export function retryDelay(attempt: number, random = Math.random, retryAfterMs = 0): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) throw new Error('INVALID_RETRY_POLICY');
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error('INVALID_RANDOM_SOURCE');
  const cap = Math.min(300000, 1000 * 2 ** Math.min(attempt - 1, 20));
  return Math.max(Math.floor(sample * cap), Math.min(retryAfterMs, 86400000));
}
export function outcomeFromException(sideEffects: Adapter['sideEffects']): DeliveryOutcome {
  return sideEffects === 'non-idempotent' ? {status: 'OUTCOME_UNKNOWN', code: 'REMOTE_OUTCOME_UNCERTAIN'} : {status: 'RETRYABLE', code: 'ATTEMPT_INTERRUPTED'};
}
