import type { Adapter, DeliveryContext, DeliveryOutcome } from "../../packages/adapter-sdk/index.ts";
import { SafeHttpError, safeHttpsRequest } from "../../packages/platform/safe-http.ts";
import type { SqlPool } from "../shared/postgres.ts";
import { tenantTransaction } from "../shared/postgres.ts";
import { decryptDeliveryConfig } from "../integrations/secret-envelope.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PAYLOAD_REF = new RegExp(`^wordpress:(${UUID})$`, "i");
const HASH = /^[0-9a-f]{64}$/;
const PERMANENT_SAFE_HTTP = new Set([
  "OUTBOUND_URL_INVALID", "OUTBOUND_URL_FORBIDDEN", "OUTBOUND_PORT_FORBIDDEN",
  "OUTBOUND_HOST_FORBIDDEN", "OUTBOUND_ADDRESS_FORBIDDEN", "OUTBOUND_REDIRECT_FORBIDDEN",
  "OUTBOUND_HEADER_INVALID", "OUTBOUND_REQUEST_TOO_LARGE", "OUTBOUND_RESPONSE_TOO_LARGE",
]);

interface ResourceRow {
  connection_id: string;
  source_type: "page" | "post";
  source_id: string;
  expected_modified_gmt: string;
  expected_hash: string;
  desired_payload: unknown;
  endpoint_url: string;
  username: string;
  credential_ciphertext: string;
  credential_iv: string;
  credential_tag: string;
  key_version: number | string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WORDPRESS_SYNC_PAYLOAD_INVALID");
  return value as Record<string, unknown>;
}

function responseCode(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.code === "string" ? parsed.code.toUpperCase().replace(/[^A-Z0-9_.:-]/g, "_").slice(0, 80) : "";
  } catch {
    return "";
  }
}

export class WordPressSyncAdapter implements Adapter {
  readonly id = "forgestudio.wordpress-sync.v1";
  readonly sideEffects = "idempotent" as const;
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) { this.pool = pool; }

  async deliver(context: DeliveryContext, payloadRef: string): Promise<DeliveryOutcome> {
    const match = PAYLOAD_REF.exec(payloadRef);
    if (!match || String(match[1]).toLowerCase() !== context.jobId) {
      return { status: "FAILED_PERMANENTLY", code: "WORDPRESS_PAYLOAD_REF_INVALID" };
    }

    const loaded = await tenantTransaction(this.pool, context.tenantId, async (tx) => {
      const receipt = await tx.query<{ source_hash: string }>(
        `SELECT source_hash FROM platform.wordpress_sync_receipts
         WHERE tenant_id=$1 AND job_id=$2 LIMIT 1`,
        [context.tenantId, context.jobId],
      );
      if (receipt.rows[0]) return { receipt: receipt.rows[0].source_hash } as const;
      const rows = await tx.query<ResourceRow>(
        `SELECT connection_id,source_type,source_id,expected_modified_gmt,expected_hash,
                desired_payload,endpoint_url,username,credential_ciphertext,credential_iv,
                credential_tag,key_version
         FROM platform.wordpress_sync_resources
         WHERE tenant_id=$1 AND job_id=$2 LIMIT 1`,
        [context.tenantId, context.jobId],
      );
      return { resource: rows.rows[0] } as const;
    });
    if ("receipt" in loaded) return { status: "DELIVERED", receipt: loaded.receipt };
    const resource = loaded.resource;
    if (!resource) return { status: "FAILED_PERMANENTLY", code: "WORDPRESS_SYNC_RESOURCE_MISSING" };

    let password: string;
    let desired: Record<string, unknown>;
    try {
      const config = decryptDeliveryConfig({
        ciphertext: resource.credential_ciphertext,
        iv: resource.credential_iv,
        tag: resource.credential_tag,
        keyVersion: Number(resource.key_version),
      }, context.tenantId, context.jobId);
      password = typeof config.applicationPassword === "string" ? config.applicationPassword : "";
      desired = object(resource.desired_payload);
      if (!password) throw new Error("WORDPRESS_CREDENTIAL_INVALID");
    } catch (error) {
      return { status: "FAILED_PERMANENTLY", code: error instanceof Error ? error.message : "WORDPRESS_CREDENTIAL_INVALID" };
    }

    let response;
    try {
      response = await safeHttpsRequest(resource.endpoint_url, {
        method: "POST",
        signal: context.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${resource.username}:${password}`, "utf8").toString("base64")}`,
          "Content-Type": "application/json",
          "User-Agent": "ForgeStudio-WordPress-Sync/1.0",
          "X-ForgeStudio-Job-Id": context.jobId,
        },
        body: JSON.stringify({
          idempotency_key: context.idempotencyKey,
          source_type: resource.source_type,
          source_id: Number(resource.source_id),
          expected_modified_gmt: resource.expected_modified_gmt,
          expected_hash: resource.expected_hash,
          desired,
        }),
        maxBytes: 256 * 1024,
        timeoutMs: 20_000,
      });
    } catch (error) {
      if (error instanceof SafeHttpError) {
        return PERMANENT_SAFE_HTTP.has(error.code)
          ? { status: "FAILED_PERMANENTLY", code: error.code }
          : { status: "RETRYABLE", code: error.code };
      }
      return { status: "RETRYABLE", code: "WORDPRESS_SYNC_REQUEST_FAILED" };
    }

    const remoteCode = responseCode(response.body);
    if (response.status === 409) {
      return { status: "FAILED_PERMANENTLY", code: remoteCode || "WORDPRESS_SOURCE_CONFLICT" };
    }
    if (response.status === 401 || response.status === 403 || response.status === 404 || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 425 && response.status !== 429)) {
      return { status: "FAILED_PERMANENTLY", code: remoteCode || `WORDPRESS_HTTP_${response.status}` };
    }
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      return { status: "RETRYABLE", code: remoteCode || `WORDPRESS_HTTP_${response.status}` };
    }

    let receipt: Record<string, unknown>;
    try { receipt = object(JSON.parse(response.body)); }
    catch { return { status: "FAILED_PERMANENTLY", code: "WORDPRESS_SYNC_RESPONSE_INVALID" }; }
    const sourceHash = typeof receipt.source_hash === "string" ? receipt.source_hash.toLowerCase() : "";
    const modified = typeof receipt.modified_gmt === "string" ? receipt.modified_gmt : "";
    const status = typeof receipt.status === "string" ? receipt.status : "";
    if (!HASH.test(sourceHash) || !modified || !status) {
      return { status: "FAILED_PERMANENTLY", code: "WORDPRESS_SYNC_RECEIPT_INVALID" };
    }

    try {
      await tenantTransaction(this.pool, context.tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO platform.wordpress_sync_receipts(
             tenant_id,job_id,connection_id,source_type,source_id,source_hash,
             source_modified_gmt,source_status,replayed
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(tenant_id,job_id) DO NOTHING`,
          [
            context.tenantId, context.jobId, resource.connection_id, resource.source_type,
            resource.source_id, sourceHash, modified, status, receipt.replayed === true,
          ],
        );
      });
    } catch {
      return { status: "RETRYABLE", code: "WORDPRESS_SYNC_RECEIPT_NOT_PERSISTED" };
    }
    return { status: "DELIVERED", receipt: sourceHash };
  }
}
