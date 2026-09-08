/** Versioned, bounded transport contracts. No customer credentials or raw leads. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Destination = 'rabbitmq' | 'kafka';
export const TOPICS = ['site.lifecycle.v1', 'content.changed.v1', 'integration.status.v1', 'usage.observed.v1'] as const;
export const JOB_TYPES = ['publish.build', 'wordpress.sync', 'media.process', 'integration.deliver', 'maintenance.reconcile'] as const;
export type JobType = typeof JOB_TYPES[number];
export interface EventEnvelope {
  schemaVersion: 1;
  eventId: string;
  tenantId: string;
  aggregateId: string;
  aggregateVersion: number;
  type: typeof TOPICS[number];
  occurredAt: string;
  traceId: string;
  payload: { [key: string]: Json };
}
export interface TaskEnvelope {
  schemaVersion: 1;
  jobId: string;
  tenantId: string;
  jobType: JobType;
  deadline: string;
  traceId: string;
}
export class ContractError extends Error {
  readonly code = 'INVALID_CONTRACT';
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('Expected an object');
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ContractError('Invalid UUID');
  return value.toLowerCase();
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ContractError('Invalid UTC timestamp');
  return value;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ContractError('Invalid revision');
  return value as number;
}
export function canonicalJson(value: unknown, maxBytes = 65536): string {
  const seen = new Set<object>();
  let nodes = 0;
  const normalize = (item: unknown, depth: number): Json => {
    if (++nodes > 20000 || depth > 64) throw new ContractError('Document complexity exceeded');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === null || seen.has(item)) throw new ContractError('Non-JSON or cyclic value');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new ContractError('Expected plain JSON');
    seen.add(item);
    let result: Json;
    if (Array.isArray(item)) result = item.map(v => normalize(v, depth + 1));
    else {
      const output: Record<string, Json> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ContractError('Unsafe property');
        output[key] = normalize((item as Record<string, unknown>)[key], depth + 1);
      }
      result = output;
    }
    seen.delete(item);
    return result;
  };
  const text = JSON.stringify(normalize(value, 0));
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ContractError('Payload exceeds byte limit');
  return text;
}
export async function fingerprint(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value, 1048576)));
  return Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, '0')).join('');
}
export function parseEvent(value: unknown): EventEnvelope {
  canonicalJson(value);
  const v = object(value);
  if (v.schemaVersion !== 1 || !TOPICS.includes(v.type as EventEnvelope['type'])) throw new ContractError('Unsupported event schema/type');
  const payload = object(v.payload) as EventEnvelope['payload'];
  return {schemaVersion: 1, eventId: uuid(v.eventId), tenantId: uuid(v.tenantId), aggregateId: uuid(v.aggregateId), aggregateVersion: revision(v.aggregateVersion), type: v.type as EventEnvelope['type'], occurredAt: timestamp(v.occurredAt), traceId: uuid(v.traceId), payload};
}
export function parseTask(value: unknown): TaskEnvelope {
  canonicalJson(value, 4096);
  const v = object(value);
  if (v.schemaVersion !== 1 || !JOB_TYPES.includes(v.jobType as JobType)) throw new ContractError('Unsupported task schema/type');
  return {schemaVersion: 1, jobId: uuid(v.jobId), tenantId: uuid(v.tenantId), jobType: v.jobType as JobType, deadline: timestamp(v.deadline), traceId: uuid(v.traceId)};
}
