import type { Destination } from '../../packages/events/index.ts';
export interface OutboxClaim {tenantId: string; eventId: string; destination: Destination; leaseToken: string; body: unknown}
export interface OutboxStore {
  claim(destination: Destination, limit: number): Promise<OutboxClaim[]>;
  markSent(claim: OutboxClaim): Promise<boolean>;
  retry(claim: OutboxClaim, code: string): Promise<boolean>;
}
export interface ConfirmedPublisher {publish(body: unknown): Promise<void>}
/** Each destination gets its own loop, lease and connection budget. */
export async function relayBatch(store: OutboxStore, destination: Destination, publisher: ConfirmedPublisher, limit = 32): Promise<{sent: number; deferred: number}> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('INVALID_BATCH_SIZE');
  const claims = await store.claim(destination, limit);
  let sent = 0; let deferred = 0;
  for (const claim of claims) {
    if (claim.destination !== destination) throw new Error('DESTINATION_MISMATCH');
    try {
      await publisher.publish(claim.body); // Must include routed/confirmed acknowledgement.
      if (await store.markSent(claim)) sent++; else deferred++;
    } catch {
      await store.retry(claim, 'DISPATCH_UNCONFIRMED'); deferred++;
    }
  }
  return {sent, deferred};
}
