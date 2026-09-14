import { createHmac, randomUUID } from "node:crypto";

export type IntegrationKind = "WEBHOOK" | "GENERIC_REST" | "EMAIL_HTTP" | "CRM_REST";
export type DeliveryState = "ACCEPTED" | "QUEUED" | "IN_PROGRESS" | "DELIVERED" | "RETRY_SCHEDULED" | "FAILED_PERMANENTLY" | "OUTCOME_UNKNOWN";

export interface TrustedDestination {
  id: string;
  tenantId: string;
  kind: IntegrationKind;
  endpoint: string;
  method: "POST" | "PUT";
  timeoutMs: number;
  maximumResponseBytes: number;
  headers?: Readonly<Record<string, string>>;
  secret?: string;
  successStatuses?: readonly number[];
}

export interface DeliveryEnvelope {
  eventId: string;
  tenantId: string;
  destinationId: string;
  eventType: string;
  occurredAt: string;
  attempt: number;
  idempotencyKey: string;
  data: unknown;
}

export interface DeliveryClassification {
  state: Exclude<DeliveryState, "ACCEPTED" | "QUEUED" | "IN_PROGRESS">;
  retryable: boolean;
  retryAfterMs?: number;
  code: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateTrustedDestination(destination: TrustedDestination): TrustedDestination {
  if (!UUID.test(destination.id) || !UUID.test(destination.tenantId)) throw new Error("INVALID_DESTINATION_SCOPE");
  const url = new URL(destination.endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.port && !/^\d{2,5}$/.test(url.port)) throw new Error("INVALID_DESTINATION_URL");
  if (["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase()) || url.hostname.endsWith(".local")) throw new Error("PRIVATE_DESTINATION_FORBIDDEN");
  if (!Number.isSafeInteger(destination.timeoutMs) || destination.timeoutMs < 500 || destination.timeoutMs > 30_000) throw new Error("INVALID_DESTINATION_TIMEOUT");
  if (!Number.isSafeInteger(destination.maximumResponseBytes) || destination.maximumResponseBytes < 0 || destination.maximumResponseBytes > 1_048_576) throw new Error("INVALID_RESPONSE_LIMIT");
  for (const [name, value] of Object.entries(destination.headers ?? {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || /^(host|content-length|connection|transfer-encoding)$/i.test(name) || value.length > 2048) throw new Error("INVALID_DESTINATION_HEADER");
  }
  for (const status of destination.successStatuses ?? []) if (!Number.isSafeInteger(status) || status < 200 || status > 299) throw new Error("INVALID_SUCCESS_STATUS");
  return { ...destination, id: destination.id.toLowerCase(), tenantId: destination.tenantId.toLowerCase(), endpoint: url.toString() };
}

export function deliveryEnvelope(input: Omit<DeliveryEnvelope, "eventId" | "occurredAt"> & Partial<Pick<DeliveryEnvelope, "eventId" | "occurredAt">>): DeliveryEnvelope {
  if (!UUID.test(input.tenantId) || !UUID.test(input.destinationId)) throw new Error("INVALID_DELIVERY_SCOPE");
  if (!/^[a-z][a-z0-9._-]{2,100}$/.test(input.eventType) || !/^[A-Za-z0-9:_-]{16,128}$/.test(input.idempotencyKey)) throw new Error("INVALID_DELIVERY_ENVELOPE");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 100) throw new Error("INVALID_DELIVERY_ATTEMPT");
  return {
    eventId: input.eventId ?? randomUUID(),
    tenantId: input.tenantId.toLowerCase(),
    destinationId: input.destinationId.toLowerCase(),
    eventType: input.eventType,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    attempt: input.attempt,
    idempotencyKey: input.idempotencyKey,
    data: input.data,
  };
}

export function webhookHeaders(destination: TrustedDestination, envelope: DeliveryEnvelope, serializedBody: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "ForgeStudio-Delivery/2.0",
    "x-forgestudio-event": envelope.eventType,
    "x-forgestudio-event-id": envelope.eventId,
    "x-forgestudio-idempotency-key": envelope.idempotencyKey,
    ...Object.fromEntries(Object.entries(destination.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
  };
  if (destination.secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    headers["x-forgestudio-timestamp"] = timestamp;
    headers["x-forgestudio-signature"] = `v1=${createHmac("sha256", destination.secret).update(`${timestamp}.${serializedBody}`).digest("hex")}`;
  }
  return headers;
}

export function classifyDelivery(status: number | null, errorCode?: string, retryAfterHeader?: string | null): DeliveryClassification {
  if (status !== null && status >= 200 && status <= 299) return { state: "DELIVERED", retryable: false, code: "DELIVERED" };
  const retryAfterSeconds = retryAfterHeader && /^\d{1,6}$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
  const retryAfterMs = retryAfterSeconds === null ? undefined : Math.min(3_600_000, retryAfterSeconds * 1000);
  if (status === 408 || status === 409 || status === 425 || status === 429 || (status !== null && status >= 500 && status <= 599)) {
    return { state: "RETRY_SCHEDULED", retryable: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), code: `HTTP_${status}` };
  }
  if (status !== null && status >= 400 && status <= 499) return { state: "FAILED_PERMANENTLY", retryable: false, code: `HTTP_${status}` };
  if (errorCode === "TIMEOUT_AFTER_WRITE" || errorCode === "CONNECTION_LOST_AFTER_WRITE") {
    return { state: "OUTCOME_UNKNOWN", retryable: false, code: errorCode };
  }
  if (errorCode === "DNS" || errorCode === "CONNECT" || errorCode === "TIMEOUT_BEFORE_WRITE" || errorCode === "TLS") {
    return { state: "RETRY_SCHEDULED", retryable: true, code: errorCode };
  }
  return { state: "FAILED_PERMANENTLY", retryable: false, code: errorCode ?? "DELIVERY_FAILED" };
}

export function retryDelayMs(attempt: number, seed: string, minimumMs = 1000, maximumMs = 15 * 60_000): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || minimumMs < 1 || maximumMs < minimumMs) throw new Error("INVALID_RETRY_POLICY");
  const digest = createHmac("sha256", seed).update(String(attempt)).digest();
  const jitter = digest.readUInt32BE(0) / 0xffffffff;
  const exponential = Math.min(maximumMs, minimumMs * 2 ** Math.min(attempt - 1, 16));
  return Math.max(minimumMs, Math.floor(exponential * (0.5 + jitter * 0.5)));
}

export function nextDeliveryState(current: DeliveryState, next: DeliveryState): DeliveryState {
  const transitions: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
    ACCEPTED: ["QUEUED", "FAILED_PERMANENTLY"],
    QUEUED: ["IN_PROGRESS", "FAILED_PERMANENTLY"],
    IN_PROGRESS: ["DELIVERED", "RETRY_SCHEDULED", "FAILED_PERMANENTLY", "OUTCOME_UNKNOWN"],
    RETRY_SCHEDULED: ["QUEUED", "FAILED_PERMANENTLY"],
    DELIVERED: [], FAILED_PERMANENTLY: [], OUTCOME_UNKNOWN: ["DELIVERED", "FAILED_PERMANENTLY", "RETRY_SCHEDULED"],
  };
  if (!transitions[current].includes(next)) throw new Error("INVALID_DELIVERY_TRANSITION");
  return next;
}
