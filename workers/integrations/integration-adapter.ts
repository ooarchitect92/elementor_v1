import { createHash, createHmac } from "node:crypto";
import type { Adapter, DeliveryContext, DeliveryOutcome } from "../../packages/adapter-sdk/index.ts";
import { SafeHttpError, safeHttpsRequest, type SafeHttpResponse } from "../../packages/platform/safe-http.ts";
import type { SqlPool } from "../shared/postgres.ts";
import { tenantTransaction } from "../shared/postgres.ts";
import { decryptDeliveryConfig } from "./secret-envelope.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PAYLOAD_REF = new RegExp(`^integration:(${UUID})$`, "i");
const PERMANENT_SAFE_HTTP = new Set([
  "OUTBOUND_URL_INVALID",
  "OUTBOUND_URL_FORBIDDEN",
  "OUTBOUND_PORT_FORBIDDEN",
  "OUTBOUND_HOST_FORBIDDEN",
  "OUTBOUND_ADDRESS_FORBIDDEN",
  "OUTBOUND_REDIRECT_FORBIDDEN",
  "OUTBOUND_HEADER_INVALID",
  "OUTBOUND_REQUEST_TOO_LARGE",
  "OUTBOUND_RESPONSE_TOO_LARGE",
]);

type JsonObject = Record<string, any>;
type Requester = typeof safeHttpsRequest;

interface ResourceRow {
  action_type: "EMAIL" | "WEBHOOK" | "CRM";
  provider: string;
  payload: unknown;
  config_ciphertext: string;
  config_iv: string;
  config_tag: string;
  key_version: number | string;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INTEGRATION_PAYLOAD_INVALID");
  return value as JsonObject;
}

function string(value: unknown, max = 4_096): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) throw new Error("INTEGRATION_CONFIG_INVALID");
  return result;
}

function responseReference(response: SafeHttpResponse): string | undefined {
  const header = response.headers["x-message-id"] || response.headers["x-request-id"] || response.headers["x-hubspot-correlation-id"];
  if (header) return header.slice(0, 512);
  try {
    const body = JSON.parse(response.body);
    const value = body?.id || body?.requestId || body?.correlationId;
    return typeof value === "string" || typeof value === "number" ? String(value).slice(0, 512) : undefined;
  } catch {
    return undefined;
  }
}

function retryAfterMs(response: SafeHttpResponse): number | undefined {
  const value = response.headers["retry-after"];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400_000, Math.floor(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(86_400_000, date - Date.now())) : undefined;
}

function responseOutcome(response: SafeHttpResponse): DeliveryOutcome | null {
  if (response.status >= 200 && response.status < 300) return null;
  if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
    return { status: "RETRYABLE", code: `REMOTE_HTTP_${response.status}`, retryAfterMs: retryAfterMs(response) };
  }
  return { status: "FAILED_PERMANENTLY", code: `REMOTE_HTTP_${response.status}` };
}

function scalarProperties(fieldsValue: unknown, mappingValue: unknown): Record<string, string> {
  const fields = object(fieldsValue);
  const mapping = mappingValue && typeof mappingValue === "object" && !Array.isArray(mappingValue)
    ? mappingValue as Record<string, unknown>
    : {};
  const result: Record<string, string> = {};
  for (const [source, raw] of Object.entries(fields).slice(0, 100)) {
    if (raw === null || raw === undefined || typeof raw === "object") continue;
    const destination = typeof mapping[source] === "string" ? String(mapping[source]) : source;
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(destination)) continue;
    result[destination] = String(raw).slice(0, 20_000);
  }
  return result;
}

function leadText(payload: JsonObject): string {
  const fields = object(payload.fields);
  const lines = [`Form: ${String(payload.formName || payload.formId || "Website form")}`];
  for (const [name, value] of Object.entries(fields).slice(0, 100)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    lines.push(`${name}: ${String(value).slice(0, 10_000)}`);
  }
  return lines.join("\n").slice(0, 100_000);
}

async function webhookRequest(config: JsonObject, payload: JsonObject, context: DeliveryContext, requester: Requester) {
  const endpointUrl = string(config.endpointUrl, 2_048);
  const body = JSON.stringify({
    event: "form.submitted",
    deliveryId: context.jobId,
    idempotencyKey: context.idempotencyKey,
    data: payload,
  });
  const secret = typeof config.secretKey === "string" ? config.secretKey : "";
  const signature = secret ? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` : "";
  return requester(endpointUrl, {
    method: "POST",
    signal: context.signal,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "ForgeStudio-Delivery/1.0",
      "X-ForgeStudio-Delivery-Id": context.jobId,
      "X-ForgeStudio-Event": "form.submitted",
      ...(signature ? { "X-ForgeStudio-Signature": signature } : {}),
    },
    body,
    maxBytes: 512 * 1024,
  });
}

async function sendgridRequest(config: JsonObject, payload: JsonObject, context: DeliveryContext, requester: Requester) {
  const body = JSON.stringify({
    personalizations: [{ to: [{ email: string(config.toEmail, 320) }] }],
    from: { email: string(config.fromEmail, 320), name: String(config.fromName || "ForgeStudio").slice(0, 120) },
    subject: string(config.subject, 300),
    content: [{ type: "text/plain", value: leadText(payload) }],
    custom_args: { forgestudio_delivery_id: context.jobId },
  });
  return requester("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    signal: context.signal,
    headers: {
      Authorization: `Bearer ${string(config.apiKey, 512)}`,
      "Content-Type": "application/json",
      "X-ForgeStudio-Delivery-Id": context.jobId,
    },
    body,
    maxBytes: 256 * 1024,
  });
}

async function hubspotRequest(config: JsonObject, payload: JsonObject, context: DeliveryContext, requester: Requester) {
  const emailField = string(config.emailField || "email", 100);
  const fields = object(payload.fields);
  const email = string(fields[emailField], 320);
  const properties = scalarProperties(fields, config.propertyMap);
  properties.email = email;
  const body = JSON.stringify({ inputs: [{ id: email, idProperty: "email", properties }] });
  return requester("https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert", {
    method: "POST",
    signal: context.signal,
    headers: {
      Authorization: `Bearer ${string(config.accessToken, 2_048)}`,
      "Content-Type": "application/json",
      "X-ForgeStudio-Delivery-Id": context.jobId,
    },
    body,
    maxBytes: 512 * 1024,
  });
}

async function genericCrmRequest(config: JsonObject, payload: JsonObject, context: DeliveryContext, requester: Requester) {
  const body = JSON.stringify({
    event: "lead.accepted",
    deliveryId: context.jobId,
    idempotencyKey: context.idempotencyKey,
    lead: scalarProperties(payload.fields, config.propertyMap),
    context: {
      websiteId: payload.websiteId,
      formId: payload.formId,
      submissionId: payload.submissionId,
      acceptedAt: payload.acceptedAt,
    },
  });
  const token = typeof config.bearerToken === "string" ? config.bearerToken.trim() : "";
  return requester(string(config.endpointUrl, 2_048), {
    method: "POST",
    signal: context.signal,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "ForgeStudio-CRM-Delivery/1.0",
      "X-ForgeStudio-Delivery-Id": context.jobId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
    maxBytes: 512 * 1024,
  });
}

export class IntegrationDeliveryAdapter implements Adapter {
  readonly id = "forgestudio.integration-delivery.v1";
  readonly sideEffects = "non-idempotent" as const;
  private readonly pool: SqlPool;
  private readonly requester: Requester;

  constructor(pool: SqlPool, requester: Requester = safeHttpsRequest) {
    this.pool = pool;
    this.requester = requester;
  }

  async deliver(context: DeliveryContext, payloadRef: string): Promise<DeliveryOutcome> {
    const match = PAYLOAD_REF.exec(payloadRef);
    if (!match || String(match[1]).toLowerCase() !== context.jobId) {
      return { status: "FAILED_PERMANENTLY", code: "INTEGRATION_PAYLOAD_REF_INVALID" };
    }

    const loaded = await tenantTransaction(this.pool, context.tenantId, async (tx) => {
      const receipt = await tx.query<{ provider_reference: string | null }>(
        `SELECT provider_reference FROM platform.integration_receipts
         WHERE tenant_id=$1 AND job_id=$2 LIMIT 1`,
        [context.tenantId, context.jobId],
      );
      if (receipt.rows[0]) return { receipt: receipt.rows[0].provider_reference || `delivery:${context.jobId}` } as const;
      const rows = await tx.query<ResourceRow>(
        `SELECT action_type,provider,payload,config_ciphertext,config_iv,config_tag,key_version
         FROM platform.integration_delivery_resources
         WHERE tenant_id=$1 AND job_id=$2 LIMIT 1`,
        [context.tenantId, context.jobId],
      );
      return { resource: rows.rows[0] } as const;
    });
    if ("receipt" in loaded) return { status: "DELIVERED", receipt: loaded.receipt };
    const resource = loaded.resource;
    if (!resource) return { status: "FAILED_PERMANENTLY", code: "INTEGRATION_RESOURCE_MISSING" };

    let config: JsonObject;
    let payload: JsonObject;
    try {
      config = decryptDeliveryConfig({
        ciphertext: resource.config_ciphertext,
        iv: resource.config_iv,
        tag: resource.config_tag,
        keyVersion: Number(resource.key_version),
      }, context.tenantId, context.jobId) as JsonObject;
      payload = object(resource.payload);
    } catch (error) {
      return { status: "FAILED_PERMANENTLY", code: error instanceof Error ? error.message : "INTEGRATION_CONFIG_INVALID" };
    }

    let response: SafeHttpResponse;
    try {
      if (resource.action_type === "WEBHOOK" && resource.provider === "WEBHOOK") {
        response = await webhookRequest(config, payload, context, this.requester);
      } else if (resource.action_type === "EMAIL" && resource.provider === "SENDGRID") {
        response = await sendgridRequest(config, payload, context, this.requester);
      } else if (resource.action_type === "CRM" && resource.provider === "HUBSPOT") {
        response = await hubspotRequest(config, payload, context, this.requester);
      } else if (resource.action_type === "CRM" && resource.provider === "GENERIC_REST") {
        response = await genericCrmRequest(config, payload, context, this.requester);
      } else {
        return { status: "FAILED_PERMANENTLY", code: "INTEGRATION_PROVIDER_UNSUPPORTED" };
      }
    } catch (error) {
      if (error instanceof SafeHttpError) {
        if (PERMANENT_SAFE_HTTP.has(error.code)) return { status: "FAILED_PERMANENTLY", code: error.code };
        return error.requestMayHaveBeenSent
          ? { status: "OUTCOME_UNKNOWN", code: error.code }
          : { status: "RETRYABLE", code: error.code };
      }
      return { status: "FAILED_PERMANENTLY", code: error instanceof Error ? error.message : "INTEGRATION_DELIVERY_FAILED" };
    }

    const failure = responseOutcome(response);
    if (failure) return failure;
    const reference = responseReference(response) || `delivery:${context.jobId}`;
    const digest = createHash("sha256").update(response.body).digest("hex");
    try {
      await tenantTransaction(this.pool, context.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO platform.integration_receipts(
             tenant_id,job_id,provider,provider_reference,http_status,response_digest
           ) VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(tenant_id,job_id) DO NOTHING`,
          [context.tenantId, context.jobId, resource.provider, reference, response.status, digest],
        );
      });
    } catch {
      return { status: "OUTCOME_UNKNOWN", code: "DELIVERY_RECEIPT_NOT_PERSISTED" };
    }
    return { status: "DELIVERED", receipt: reference };
  }
}
