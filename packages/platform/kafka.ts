import { parseEvent, canonicalJson } from '../events/index.ts';
export const KAFKA_PRODUCER_POLICY = {idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false} as const;
export interface KafkaPort {
  send(input: {topic: string; acks: -1; timeout: number; messages: {key: string; value: string; headers: Record<string, string>}[]}): Promise<unknown>;
}
export class KafkaEventPublisher {
  private producer: KafkaPort;
  constructor(producer: KafkaPort) { this.producer = producer; }
  async publish(input: unknown): Promise<void> {
    const event = parseEvent(input);
    await this.producer.send({topic: event.type, acks: -1, timeout: 10000, messages: [{key: `${event.tenantId}:${event.aggregateId}`, value: canonicalJson(event), headers: {'event-id': event.eventId, 'schema-version': '1', 'trace-id': event.traceId}}]});
  }
}
/** Must be invoked inside the same DB transaction as a local projection effect. */
export interface InboxTransaction {
  insertOnce(tenantId: string, consumer: string, eventId: string): Promise<boolean>;
}
export async function applyOnce(tx: InboxTransaction, tenantId: string, consumer: string, eventId: string, apply: () => Promise<void>): Promise<boolean> {
  if (!await tx.insertOnce(tenantId, consumer, eventId)) return false;
  await apply(); // The caller MUST rollback the inbox insertion when this fails.
  return true;
}
