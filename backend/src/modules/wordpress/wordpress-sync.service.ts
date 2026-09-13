import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { prisma } from "../../config/prisma.js";
import { getWebsiteById } from "../../services/website.service.js";
import { ensurePlatformTenant } from "../../services/platform-tenant.service.js";
import { AppError } from "../../utils/app-error.js";
import { deliveryHash, encryptDeliveryConfig, stableJson } from "../integrations-v2/delivery-crypto.js";

const REQUEST_KEY = /^[A-Za-z0-9:_-]{16,128}$/;
const SOURCE_TYPE = /^(page|post)$/;
const HASH = /^[0-9a-f]{64}$/;
type JsonObject = Record<string, any>;

export interface QueueWordPressSyncInput {
  requestKey: string;
  sourceType: string;
  sourceId: string;
  expectedSourceHash: string;
  desired: {
    title?: string;
    content?: string;
    excerpt?: string;
    status?: "draft" | "pending" | "private" | "publish";
    slug?: string;
  };
  requestId?: string;
}

function wordpressKey(): Buffer {
  const key = Buffer.from(process.env.WORDPRESS_SECRET_KEY_BASE64 || "", "base64");
  if (key.length !== 32) throw new AppError("WordPress secret encryption is not configured", 503, "WORDPRESS_SECRET_KEY_NOT_CONFIGURED");
  return key;
}

function decryptWordPressSecret(row: any): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", wordpressKey(), Buffer.from(row.secretIv, "base64"));
    decipher.setAuthTag(Buffer.from(row.secretTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(row.secretCiphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppError("WordPress credentials could not be decrypted", 503, "WORDPRESS_SECRET_DECRYPT_FAILED");
  }
}

function bounded(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > max) {
    throw new AppError(`Invalid WordPress ${field}`, 400, "WORDPRESS_SYNC_PAYLOAD_INVALID");
  }
  return value;
}

function normalizeDesired(input: QueueWordPressSyncInput["desired"]): JsonObject {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("WordPress desired content is required", 400, "WORDPRESS_SYNC_PAYLOAD_INVALID");
  }
  const status = input.status === undefined ? undefined : String(input.status);
  if (status && !["draft", "pending", "private", "publish"].includes(status)) {
    throw new AppError("Unsupported WordPress status", 400, "WORDPRESS_SYNC_STATUS_INVALID");
  }
  const desired: JsonObject = {};
  const title = bounded(input.title, 2 * 1024 * 1024, "title");
  const content = bounded(input.content, 2 * 1024 * 1024, "content");
  const excerpt = bounded(input.excerpt, 2 * 1024 * 1024, "excerpt");
  const slug = bounded(input.slug, 300, "slug");
  if (title !== undefined) desired.title = title;
  if (content !== undefined) desired.content = content;
  if (excerpt !== undefined) desired.excerpt = excerpt;
  if (status !== undefined) desired.status = status;
  if (slug !== undefined) desired.slug = slug;
  if (Object.keys(desired).length === 0) throw new AppError("At least one WordPress field must change", 400, "WORDPRESS_SYNC_EMPTY");
  return desired;
}

function raw(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row.raw === "string") return row.raw;
    if (typeof row.rendered === "string") return row.rendered;
  }
  return "";
}

function canonicalSourceHash(sourceType: string, sourceId: string, payloadValue: unknown): string {
  const payload = payloadValue && typeof payloadValue === "object" && !Array.isArray(payloadValue)
    ? payloadValue as Record<string, unknown>
    : {};
  const snapshot = {
    source_type: sourceType,
    source_id: Number(sourceId),
    title: raw(payload.title),
    content: raw(payload.content),
    excerpt: raw(payload.excerpt),
    status: typeof payload.status === "string" ? payload.status : "",
    slug: typeof payload.slug === "string" ? payload.slug : "",
    modified_gmt: typeof payload.modified_gmt === "string" ? payload.modified_gmt : "",
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function syncDeadline(): string {
  const seconds = Number(process.env.WORDPRESS_SYNC_DEADLINE_SECONDS || 3_600);
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86_400) {
    throw new AppError("Invalid WordPress synchronization deadline", 500, "WORDPRESS_SYNC_CONFIGURATION_INVALID");
  }
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

function publicJob(row: any, duplicate: boolean) {
  return {
    id: row.id,
    state: row.state,
    jobType: row.job_type,
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || 0),
    deadline: row.deadline,
    createdAt: row.created_at,
    duplicate,
  };
}

export async function queueWordPressSync(
  websiteId: string,
  connectionId: string,
  userId: string,
  inputValue: QueueWordPressSyncInput,
) {
  const website: any = await getWebsiteById(websiteId, userId);
  if (website.userPermission !== "OWNER" && website.userPermission !== "ADMIN") {
    throw new AppError("Only website owners and admins can synchronize WordPress", 403, "WORDPRESS_FORBIDDEN");
  }
  const requestKey = String(inputValue.requestKey || "").trim();
  const sourceType = String(inputValue.sourceType || "").toLowerCase();
  const sourceId = String(inputValue.sourceId || "").trim();
  const expectedSourceHash = String(inputValue.expectedSourceHash || "").toLowerCase();
  if (!REQUEST_KEY.test(requestKey)) throw new AppError("requestKey must be 16-128 URL-safe characters", 400, "INVALID_REQUEST_KEY");
  if (!SOURCE_TYPE.test(sourceType) || !/^\d{1,20}$/.test(sourceId) || !HASH.test(expectedSourceHash)) {
    throw new AppError("WordPress source preconditions are invalid", 400, "WORDPRESS_SYNC_PRECONDITION_INVALID");
  }
  const desired = normalizeDesired(inputValue.desired);

  const connections = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id,"websiteId","siteUrl",username,"secretCiphertext","secretIv","secretTag",capabilities,status
     FROM wordpress_connections
     WHERE id=$1::uuid AND "websiteId"=$2::uuid
     LIMIT 1`,
    connectionId,
    websiteId,
  );
  const connection = connections[0];
  if (!connection) throw new AppError("WordPress connection not found", 404, "WORDPRESS_CONNECTION_NOT_FOUND");
  if (connection.status !== "ACTIVE") throw new AppError("WordPress connection is not active", 409, "WORDPRESS_CONNECTION_INACTIVE");
  if (connection.capabilities?.capabilities?.write_sync !== true) {
    throw new AppError("The connected WordPress user or plugin does not permit write synchronization", 409, "WORDPRESS_WRITE_SYNC_DISABLED");
  }

  const snapshots = await prisma.$queryRawUnsafe<any[]>(
    `SELECT "sourceModified","sourceHash",payload
     FROM wordpress_source_snapshots
     WHERE "connectionId"=$1::uuid AND "websiteId"=$2::uuid AND "sourceType"=$3 AND "sourceId"=$4
     LIMIT 1`,
    connectionId,
    websiteId,
    sourceType,
    sourceId,
  );
  const snapshot = snapshots[0];
  if (!snapshot) throw new AppError("Import the WordPress source before synchronizing it", 409, "WORDPRESS_SOURCE_IMPORT_REQUIRED");
  if (String(snapshot.sourceHash) !== expectedSourceHash) {
    throw new AppError("The selected imported source is stale; refresh the WordPress snapshot", 409, "WORDPRESS_IMPORTED_SOURCE_CHANGED");
  }
  const expectedModified = String(snapshot.sourceModified || snapshot.payload?.modified_gmt || "");
  if (!expectedModified) throw new AppError("Imported source has no modification precondition", 409, "WORDPRESS_SOURCE_PRECONDITION_MISSING");
  const expectedHash = canonicalSourceHash(sourceType, sourceId, snapshot.payload);
  const tenantId = String(website.userId);
  const traceId = inputValue.requestId && /^[0-9a-f-]{36}$/i.test(inputValue.requestId) ? inputValue.requestId : randomUUID();
  const jobId = randomUUID();
  const eventId = randomUUID();
  const deadline = syncDeadline();
  const endpointUrl = `${String(connection.siteUrl).replace(/\/+$/, "")}/wp-json/forgestudio/v1/sync`;
  const credential = encryptDeliveryConfig({
    applicationPassword: decryptWordPressSecret(connection),
  }, tenantId, jobId);
  const requestHash = deliveryHash({ connectionId, sourceType, sourceId, expectedSourceHash, desired });
  const payloadRef = `wordpress:${jobId}`;

  return prisma.$transaction(async (tx: any) => {
    await ensurePlatformTenant(tx, tenantId, userId, "OWNER");
    const duplicates = await tx.$queryRawUnsafe(
      `SELECT id,state,job_type,attempt,max_attempts,deadline,created_at,request_hash
       FROM platform.jobs
       WHERE tenant_id=$1::uuid AND job_type='wordpress.sync' AND idempotency_key=$2
       LIMIT 1`,
      tenantId,
      requestKey,
    ) as any[];
    if (duplicates[0]) {
      if (String(duplicates[0].request_hash) !== requestHash) {
        throw new AppError("requestKey was already used with different WordPress content", 409, "IDEMPOTENCY_KEY_REUSED");
      }
      return publicJob(duplicates[0], true);
    }

    await tx.$executeRawUnsafe(
      `INSERT INTO platform.jobs(
         tenant_id,id,job_type,idempotency_key,request_hash,payload_ref,trace_id,
         state,side_effects,max_attempts,deadline
       ) VALUES($1::uuid,$2::uuid,'wordpress.sync',$3,$4,$5,$6::uuid,
                'ACCEPTED','idempotent',6,$7::timestamptz)`,
      tenantId,
      jobId,
      requestKey,
      requestHash,
      payloadRef,
      traceId,
      deadline,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.wordpress_sync_resources(
         tenant_id,job_id,website_id,connection_id,source_type,source_id,
         expected_modified_gmt,expected_hash,desired_payload,endpoint_url,username,
         credential_ciphertext,credential_iv,credential_tag,key_version
       ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
      tenantId,
      jobId,
      websiteId,
      connectionId,
      sourceType,
      sourceId,
      expectedModified,
      expectedHash,
      JSON.stringify(desired),
      endpointUrl,
      connection.username,
      credential.ciphertext,
      credential.iv,
      credential.tag,
      credential.keyVersion,
    );
    const task = { schemaVersion: 1, jobId, tenantId, jobType: "wordpress.sync", deadline, traceId };
    const event = {
      schemaVersion: 1,
      eventId,
      tenantId,
      aggregateId: jobId,
      aggregateVersion: 0,
      type: "integration.status.v1",
      occurredAt: new Date().toISOString(),
      traceId,
      payload: { state: "ACCEPTED", provider: "WORDPRESS", sourceType, sourceId, websiteId },
    };
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.outbox_events(tenant_id,event_id,aggregate_id,aggregate_version,event_type,body)
       VALUES($1::uuid,$2::uuid,$3::uuid,0,'integration.status.v1',$4::jsonb)`,
      tenantId,
      eventId,
      jobId,
      stableJson(event),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.outbox_deliveries(tenant_id,event_id,destination,body)
       VALUES($1::uuid,$2::uuid,'rabbitmq',$3::jsonb),($1::uuid,$2::uuid,'kafka',$4::jsonb)`,
      tenantId,
      eventId,
      stableJson(task),
      stableJson(event),
    );
    return publicJob({ id: jobId, state: "ACCEPTED", job_type: "wordpress.sync", attempt: 0, max_attempts: 6, deadline, created_at: new Date() }, false);
  });
}
