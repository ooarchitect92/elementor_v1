import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/app-error.js";
import { getWebsiteById } from "../../services/website.service.js";
import { ensurePlatformTenant } from "../../services/platform-tenant.service.js";

const REQUEST_KEY = /^[A-Za-z0-9:_-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PublishAccess {
  tenantId: string;
  permission: "OWNER" | "ADMIN";
  sourceRevision: number;
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

function requestFingerprint(payloadRef: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ jobType: "publish.build", payloadRef }))
    .digest("hex");
}

function publicJob(row: any, replayed = false) {
  return {
    id: String(row.id),
    websiteId: String(row.resource_id),
    sourceRevision: Number(row.source_revision),
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

async function publishAccess(websiteIdInput: string, userId: string): Promise<PublishAccess> {
  const websiteId = validateUuid(websiteIdInput, "INVALID_WEBSITE_ID");
  const website: any = await getWebsiteById(websiteId, userId);
  const permission = String(website.userPermission || "NONE");
  if (permission !== "OWNER" && permission !== "ADMIN") {
    throw new AppError("Only owners and admins can publish", 403, "PUBLISH_FORBIDDEN");
  }
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT "userId","currentRevision" FROM websites WHERE id=$1::uuid LIMIT 1`,
    websiteId,
  );
  const row = rows[0];
  if (!row) throw new AppError("Website not found", 404, "WEBSITE_NOT_FOUND");
  const sourceRevision = Number(row.currentRevision);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
    throw new AppError("Website revision is invalid", 409, "WEBSITE_REVISION_INVALID");
  }
  return {
    tenantId: String(row.userId).toLowerCase(),
    permission,
    sourceRevision,
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
  const access = await publishAccess(websiteId, userId);
  const jobId = randomUUID();
  const eventId = randomUUID();
  const deadline = new Date(Date.now() + boundedDeadlineSeconds() * 1000).toISOString();
  const payloadRef = `artifact:publish/${websiteId}/${access.sourceRevision}`;
  const requestHash = requestFingerprint(payloadRef);
  const task = {
    schemaVersion: 1,
    jobId,
    tenantId: access.tenantId,
    jobType: "publish.build",
    deadline,
    traceId,
  };
  const event = {
    schemaVersion: 1,
    eventId,
    tenantId: access.tenantId,
    aggregateId: jobId,
    aggregateVersion: access.sourceRevision,
    type: "site.lifecycle.v1",
    occurredAt: new Date().toISOString(),
    traceId,
    payload: {
      action: "publish.requested",
      websiteId,
      sourceRevision: access.sourceRevision,
      requestedBy: userId,
    },
  };

  return prisma.$transaction(async (tx: any) => {
    const actorRole = access.permission === "OWNER" ? "OWNER" : "ADMIN";
    await ensurePlatformTenant(tx, access.tenantId, userId, actorRole);

    const inserted = await tx.$queryRawUnsafe<any[]>(
      `INSERT INTO platform.jobs(
         tenant_id,id,job_type,idempotency_key,request_hash,payload_ref,
         trace_id,deadline,state,side_effects,max_attempts
       ) VALUES($1::uuid,$2::uuid,'publish.build',$3,$4,$5,$6::uuid,$7::timestamptz,'ACCEPTED','idempotent',5)
       ON CONFLICT(tenant_id,job_type,idempotency_key) DO NOTHING
       RETURNING id,state,attempt,max_attempts,result,deadline,created_at,updated_at`,
      access.tenantId,
      jobId,
      requestKey,
      requestHash,
      payloadRef,
      traceId,
      deadline,
    );

    if (!inserted[0]) {
      const existing = await tx.$queryRawUnsafe<any[]>(
        `SELECT j.id,j.state,j.attempt,j.max_attempts,j.result,j.deadline,j.created_at,j.updated_at,
                j.request_hash,j.payload_ref,r.resource_id,r.source_revision
         FROM platform.jobs j
         JOIN platform.job_resources r
           ON r.tenant_id=j.tenant_id AND r.job_id=j.id
         WHERE j.tenant_id=$1::uuid AND j.job_type='publish.build' AND j.idempotency_key=$2
         LIMIT 1`,
        access.tenantId,
        requestKey,
      );
      const row = existing[0];
      if (
        !row ||
        String(row.request_hash) !== requestHash ||
        String(row.payload_ref) !== payloadRef ||
        String(row.resource_id) !== websiteId ||
        Number(row.source_revision) !== access.sourceRevision
      ) {
        throw new AppError("Idempotency key was used for different work", 409, "IDEMPOTENCY_KEY_REUSED");
      }
      return publicJob(row, true);
    }

    await tx.$executeRawUnsafe(
      `INSERT INTO platform.job_resources(
         tenant_id,job_id,resource_type,resource_id,source_revision,requested_by
       ) VALUES($1::uuid,$2::uuid,'WEBSITE_PUBLISH',$3::uuid,$4,$5::uuid)`,
      access.tenantId,
      jobId,
      websiteId,
      access.sourceRevision,
      userId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.outbox_events(
         tenant_id,event_id,aggregate_id,aggregate_version,event_type,body
       ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,'site.lifecycle.v1',$5::jsonb)`,
      access.tenantId,
      eventId,
      jobId,
      access.sourceRevision,
      JSON.stringify(event),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.outbox_deliveries(
         tenant_id,event_id,destination,body
       ) VALUES
         ($1::uuid,$2::uuid,'rabbitmq',$3::jsonb),
         ($1::uuid,$2::uuid,'kafka',$4::jsonb)`,
      access.tenantId,
      eventId,
      JSON.stringify(task),
      JSON.stringify(event),
    );

    return publicJob({
      ...inserted[0],
      resource_id: websiteId,
      source_revision: access.sourceRevision,
    });
  });
}

export async function getPublishJob(websiteIdInput: string, userId: string, jobIdInput: string) {
  const websiteId = validateUuid(websiteIdInput, "INVALID_WEBSITE_ID");
  const jobId = validateUuid(jobIdInput, "INVALID_JOB_ID");
  const access = await publishAccess(websiteId, userId);
  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", access.tenantId);
    const rows = await tx.$queryRawUnsafe<any[]>(
      `SELECT j.id,j.state,j.attempt,j.max_attempts,j.result,j.deadline,j.created_at,j.updated_at,
              r.resource_id,r.source_revision
       FROM platform.jobs j
       JOIN platform.job_resources r
         ON r.tenant_id=j.tenant_id AND r.job_id=j.id
       WHERE j.tenant_id=$1::uuid AND j.id=$2::uuid
         AND j.job_type='publish.build' AND r.resource_id=$3::uuid
       LIMIT 1`,
      access.tenantId,
      jobId,
      websiteId,
    );
    if (!rows[0]) throw new AppError("Publish job not found", 404, "PUBLISH_JOB_NOT_FOUND");
    return publicJob(rows[0]);
  });
}

export async function listPublishJobs(websiteIdInput: string, userId: string, limitInput = 30) {
  const websiteId = validateUuid(websiteIdInput, "INVALID_WEBSITE_ID");
  const access = await publishAccess(websiteId, userId);
  const limit = Math.max(1, Math.min(100, Math.trunc(limitInput || 30)));
  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", access.tenantId);
    const rows = await tx.$queryRawUnsafe<any[]>(
      `SELECT j.id,j.state,j.attempt,j.max_attempts,j.result,j.deadline,j.created_at,j.updated_at,
              r.resource_id,r.source_revision
       FROM platform.jobs j
       JOIN platform.job_resources r
         ON r.tenant_id=j.tenant_id AND r.job_id=j.id
       WHERE j.tenant_id=$1::uuid AND j.job_type='publish.build' AND r.resource_id=$2::uuid
       ORDER BY j.created_at DESC
       LIMIT $3`,
      access.tenantId,
      websiteId,
      limit,
    );
    return rows.map((row) => publicJob(row));
  });
}
