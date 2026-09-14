import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/app-error.js";
import { getWebsiteById } from "../../services/website.service.js";
import { ensurePlatformTenant } from "../../services/platform-tenant.service.js";
import { contentHash } from "../core-v1/editor-merge.js";

const REQUEST_KEY = /^[A-Za-z0-9:_-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type QueryRow = Record<string, any>;

interface PublishAccess {
  tenantId: string;
  permission: "OWNER" | "ADMIN";
}

function boundedDeadlineSeconds(): number {
  const raw = Number(process.env.PUBLISH_JOB_DEADLINE_SECONDS || 900);
  if (!Number.isSafeInteger(raw) || raw < 60 || raw > 86400) {
    throw new AppError("Invalid publish deadline configuration", 500, "PUBLISH_CONFIGURATION_INVALID");
  }
  return raw;
}

function validateRequestKey(value: string): string {
  const key = value.trim();
  if (!REQUEST_KEY.test(key)) {
    throw new AppError("Idempotency key must be 16-128 URL-safe characters", 400, "INVALID_IDEMPOTENCY_KEY");
  }
  return key;
}

function validateUuid(value: string, code: string): string {
  if (!UUID.test(value)) throw new AppError("Invalid identifier", 400, code);
  return value.toLowerCase();
}

function requestFingerprint(payloadRef: string, sourceHash: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ jobType: "publish.build", payloadRef, sourceHash }))
    .digest("hex");
}

function publicJob(row: QueryRow, replayed = false) {
  return {
    id: String(row.id),
    websiteId: String(row.resource_id),
    sourceRevision: Number(row.source_revision),
    sourceHash: row.source_hash ? String(row.source_hash) : undefined,
    state: String(row.state),
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || 0),
    result: row.result ?? null,
    deadline: row.deadline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    replayed,
  };
}

async function publisherAccess(websiteIdInput: string, userId: string): Promise<PublishAccess> {
  const websiteId = validateUuid(websiteIdInput, "INVALID_WEBSITE_ID");
  const website: any = await getWebsiteById(websiteId, userId);
  const permission = String(website.userPermission || "NONE");
  if (permission !== "OWNER" && permission !== "ADMIN") {
    throw new AppError("Only owners and admins can publish", 403, "PUBLISH_FORBIDDEN");
  }
  return {
    tenantId: validateUuid(String(website.userId), "INVALID_TENANT_ID"),
    permission,
  };
}

export async function createPublishJob(
  websiteIdInput: string,
  userId: string,
  requestKeyInput: string,
  requestIdInput: string,
) {
  const websiteId = validateUuid(websiteIdInput, "INVALID_WEBSITE_ID");
  const requestKey = validateRequestKey(requestKeyInput);
  const traceId = UUID.test(requestIdInput) ? requestIdInput.toLowerCase() : randomUUID();
  const access = await publisherAccess(websiteId, userId);
  const jobId = randomUUID();
  const eventId = randomUUID();
  const deadline = new Date(Date.now() + boundedDeadlineSeconds() * 1000).toISOString();

  return prisma.$transaction(async (tx: any) => {
    const actorRole = access.permission === "OWNER" ? "OWNER" : "ADMIN";
    await ensurePlatformTenant(tx, access.tenantId, userId, actorRole);

    // The parent website lock freezes editor state and blocks concurrent child inserts that need
    // a foreign-key key-share lock. Existing dependency rows are share-locked below.
    const sourceRows = await tx.$queryRawUnsafe(
      `SELECT w.id,w.name,w.slug,w."currentRevision",r."editorData",r."performanceSettings"
       FROM websites w
       JOIN website_revisions r
         ON r."websiteId"=w.id AND r.revision=w."currentRevision"
       WHERE w.id=$1::uuid
       FOR UPDATE OF w`,
      websiteId,
    ) as QueryRow[];
    const source = sourceRows[0];
    if (!source) throw new AppError("Publish source revision is missing", 409, "PUBLISH_SOURCE_MISSING");
    const sourceRevision = Number(source.currentRevision);
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
      throw new AppError("Website revision is invalid", 409, "WEBSITE_REVISION_INVALID");
    }

    const customCode = await tx.$queryRawUnsafe(
      `SELECT id,name,title,"codeType",language,placement,location,scope,"pageId",code,
              priority,conditions,status,"isEnabled","isActive","isDraft"
       FROM custom_code_snippets
       WHERE "websiteId"=$1::uuid AND "isEnabled"=true AND "isActive"=true AND "isDraft"=false
       ORDER BY priority DESC,id
       FOR SHARE`,
      websiteId,
    ) as QueryRow[];
    const themeRules = await tx.$queryRawUnsafe(
      `SELECT id,"locationType","templateId",conditions,"isActive"
       FROM theme_location_rules
       WHERE "websiteId"=$1::uuid AND "isActive"=true
       ORDER BY id
       FOR SHARE`,
      websiteId,
    ) as QueryRow[];

    const sourcePayload = {
      website: { id: source.id, name: source.name, slug: source.slug, status: "PUBLISHED" },
      editorData: source.editorData,
      performanceSettings: source.performanceSettings || {},
      customCodeSnippets: customCode,
      themeLocationRules: themeRules,
    };
    const sourceHash = contentHash(sourcePayload);
    const payloadRef = `artifact:publish/${websiteId}/${sourceRevision}`;
    const requestHash = requestFingerprint(payloadRef, sourceHash);
    const task = { schemaVersion: 1, jobId, tenantId: access.tenantId, jobType: "publish.build", deadline, traceId };
    const event = {
      schemaVersion: 1,
      eventId,
      tenantId: access.tenantId,
      aggregateId: jobId,
      aggregateVersion: sourceRevision,
      type: "site.lifecycle.v1",
      occurredAt: new Date().toISOString(),
      traceId,
      payload: { action: "publish.requested", websiteId, sourceRevision, sourceHash, requestedBy: userId },
    };

    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO platform.jobs(
         tenant_id,id,job_type,idempotency_key,request_hash,payload_ref,
         trace_id,deadline,state,side_effects,max_attempts
       ) VALUES($1::uuid,$2::uuid,'publish.build',$3,$4,$5,$6::uuid,$7::timestamptz,'ACCEPTED','idempotent',5)
       ON CONFLICT(tenant_id,job_type,idempotency_key) DO NOTHING
       RETURNING id,state,attempt,max_attempts,result,deadline,created_at,updated_at`,
      access.tenantId, jobId, requestKey, requestHash, payloadRef, traceId, deadline,
    ) as QueryRow[];

    if (!inserted[0]) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT j.id,j.state,j.attempt,j.max_attempts,j.result,j.deadline,j.created_at,j.updated_at,
                j.request_hash,j.payload_ref,r.resource_id,r.source_revision,r.source_hash
         FROM platform.jobs j
         JOIN platform.job_resources r ON r.tenant_id=j.tenant_id AND r.job_id=j.id
         WHERE j.tenant_id=$1::uuid AND j.job_type='publish.build' AND j.idempotency_key=$2
         LIMIT 1`,
        access.tenantId, requestKey,
      ) as QueryRow[];
      const row = existing[0];
      if (!row || String(row.request_hash) !== requestHash || String(row.payload_ref) !== payloadRef ||
          String(row.resource_id) !== websiteId || Number(row.source_revision) !== sourceRevision ||
          String(row.source_hash) !== sourceHash) {
        throw new AppError("Idempotency key was used for different work", 409, "IDEMPOTENCY_KEY_REUSED");
      }
      return publicJob(row, true);
    }

    await tx.$executeRawUnsafe(
      `INSERT INTO platform.job_resources(
         tenant_id,job_id,resource_type,resource_id,source_revision,source_hash,source_payload,requested_by
       ) VALUES($1::uuid,$2::uuid,'WEBSITE_PUBLISH',$3::uuid,$4,$5,$6::jsonb,$7::uuid)`,
      access.tenantId, jobId, websiteId, sourceRevision, sourceHash, JSON.stringify(sourcePayload), userId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.outbox_events(tenant_id,event_id,aggregate_id,aggregate_version,event_type,body)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4,'site.lifecycle.v1',$5::jsonb)`,
      access.tenantId, eventId, jobId, sourceRevision, JSON.stringify(event),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.outbox_deliveries(tenant_id,event_id,destination,body)
       VALUES ($1::uuid,$2::uuid,'rabbitmq',$3::jsonb),($1::uuid,$2::uuid,'kafka',$4::jsonb)`,
      access.tenantId, eventId, JSON.stringify(task), JSON.stringify(event),
    );

    return publicJob({ ...inserted[0], resource_id: websiteId, source_revision: sourceRevision, source_hash: sourceHash });
  });
}

export async function getPublishJob(websiteIdInput: string, userId: string, jobIdInput: string) {
  const websiteId = validateUuid(websiteIdInput, "INVALID_WEBSITE_ID");
  const jobId = validateUuid(jobIdInput, "INVALID_JOB_ID");
  const access = await publisherAccess(websiteId, userId);
  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", access.tenantId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT j.id,j.state,j.attempt,j.max_attempts,j.result,j.deadline,j.created_at,j.updated_at,
              r.resource_id,r.source_revision,r.source_hash
       FROM platform.jobs j JOIN platform.job_resources r ON r.tenant_id=j.tenant_id AND r.job_id=j.id
       WHERE j.tenant_id=$1::uuid AND j.id=$2::uuid AND j.job_type='publish.build' AND r.resource_id=$3::uuid
       LIMIT 1`,
      access.tenantId, jobId, websiteId,
    ) as QueryRow[];
    if (!rows[0]) throw new AppError("Publish job not found", 404, "PUBLISH_JOB_NOT_FOUND");
    return publicJob(rows[0]);
  });
}

export async function listPublishJobs(websiteIdInput: string, userId: string, limitInput = 30) {
  const websiteId = validateUuid(websiteIdInput, "INVALID_WEBSITE_ID");
  const access = await publisherAccess(websiteId, userId);
  const limit = Math.max(1, Math.min(100, Math.trunc(limitInput || 30)));
  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", access.tenantId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT j.id,j.state,j.attempt,j.max_attempts,j.result,j.deadline,j.created_at,j.updated_at,
              r.resource_id,r.source_revision,r.source_hash
       FROM platform.jobs j JOIN platform.job_resources r ON r.tenant_id=j.tenant_id AND r.job_id=j.id
       WHERE j.tenant_id=$1::uuid AND j.job_type='publish.build' AND r.resource_id=$2::uuid
       ORDER BY j.created_at DESC LIMIT $3`,
      access.tenantId, websiteId, limit,
    ) as QueryRow[];
    return rows.map((row: QueryRow) => publicJob(row));
  });
}

export async function activateReleaseAsLatestIntent(websiteIdInput: string, userId: string, releaseIdInput: string) {
  const websiteId = validateUuid(websiteIdInput, "INVALID_WEBSITE_ID");
  const releaseId = validateUuid(releaseIdInput, "INVALID_RELEASE_ID");
  await publisherAccess(websiteId, userId);
  return prisma.$transaction(async (tx: any) => {
    const site = await tx.$queryRawUnsafe(
      `SELECT id FROM websites WHERE id=$1::uuid FOR UPDATE`, websiteId,
    ) as QueryRow[];
    if (!site[0]) throw new AppError("Website not found", 404, "WEBSITE_NOT_FOUND");
    const target = await tx.$queryRawUnsafe(
      `SELECT id,"releaseNumber","sourceRevision","contentHash" FROM site_releases
       WHERE id=$1::uuid AND "websiteId"=$2::uuid LIMIT 1`,
      releaseId, websiteId,
    ) as QueryRow[];
    if (!target[0]) throw new AppError("Release not found", 404, "RELEASE_NOT_FOUND");
    await tx.$executeRawUnsafe(`UPDATE site_releases SET status='RETIRED' WHERE "websiteId"=$1::uuid AND status='ACTIVE'`, websiteId);
    const activated = await tx.$queryRawUnsafe(
      `UPDATE site_releases SET status='ACTIVE',"activatedAt"=NOW(),"requestAcceptedAt"=NOW()
       WHERE id=$1::uuid
       RETURNING id,"releaseNumber","sourceRevision","contentHash",status,"activatedAt","requestAcceptedAt"`,
      releaseId,
    ) as QueryRow[];
    await tx.$executeRawUnsafe(`UPDATE websites SET status='PUBLISHED',"updatedAt"=NOW() WHERE id=$1::uuid`, websiteId);
    return activated[0];
  });
}
