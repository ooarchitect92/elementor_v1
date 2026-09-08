export type JobState = 'ACCEPTED' | 'QUEUED' | 'RUNNING' | 'RETRY_SCHEDULED' | 'SUCCEEDED' | 'FAILED_PERMANENTLY' | 'OUTCOME_UNKNOWN' | 'CANCELLED';
const transitions: Record<JobState, readonly JobState[]> = {
  ACCEPTED: ['QUEUED', 'CANCELLED', 'FAILED_PERMANENTLY'],
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED_PERMANENTLY'],
  RUNNING: ['SUCCEEDED', 'RETRY_SCHEDULED', 'FAILED_PERMANENTLY', 'OUTCOME_UNKNOWN'],
  RETRY_SCHEDULED: ['QUEUED', 'CANCELLED', 'FAILED_PERMANENTLY'],
  OUTCOME_UNKNOWN: [], SUCCEEDED: [], FAILED_PERMANENTLY: [], CANCELLED: []
};
export function transition(from: JobState, to: JobState): JobState {
  if (!transitions[from]?.includes(to)) throw new Error('INVALID_JOB_TRANSITION');
  return to;
}
/** OUTCOME_UNKNOWN requires an audited reconciliation command, not blind retry. */
export function expiredLeaseOutcome(sideEffects: 'none' | 'idempotent' | 'non-idempotent'): JobState {
  return sideEffects === 'non-idempotent' ? 'OUTCOME_UNKNOWN' : 'RETRY_SCHEDULED';
}
export function ownsLease(storedToken: string, suppliedToken: string, expiresAt: number, now: number): boolean {
  return storedToken.length > 0 && storedToken === suppliedToken && Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt > now;
}
