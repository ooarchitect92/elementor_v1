import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/app-error.js";
import { ensurePlatformTenant } from "../../services/platform-tenant.service.js";
import { planTrustedDeliveryActions } from "./action-planner.js";
import { deliveryHash, encryptDeliveryConfig, stableJson } from "./delivery-crypto.js";

const REQUEST_KEY = /^[A-Za-z0-9:_-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, any>;

export interface PersistFormDeliveryInput {
  tenantId: string;
  websiteId: string;
  releaseId: string;
  formId: string;
  formName: string;
  fields: JsonObject;
  metadata: JsonObject;
  actions: JsonObject;
  requestKey: string;
  requestId?: string;
}

function validUuid(value: string, code: string): string {
  if (!UUID.test(value)) throw new AppError("Invalid identifier", 400, code);
  return value.toLowerCase();
}

function requestKey(value: string): string {
  const key = value.trim();
  if (!REQUEST_KEY.test(key)) throw new AppError("Idempotency-Key must be 16-128 URL-safe characters", 400, "INVALID_IDEMPOTENCY_KEY");
  return key;
}

function deadline(): string {
  const seconds = Number(process.env.INTEGRATION_JOB_DEADLINE_SECONDS || 86_400);
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 604_800) {
    throw new AppError("Invalid integration deadline configuration", 500, "INTEGRATION_CONFIGURATION_INVALID");
  }
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

function hashSubmission(input: PersistFormDeliveryInput): string {
  return createHash("sha256").update(stableJson({
    websiteId: input.websiteId,
    releaseId: input.releaseId,
    formId: input.formId,
    fields: input.fields,
  })).digest("hex");
}

function publicResult(row: any, replayed: boolean, queued: number, rejected: number) {
  return {
    submissionId: String(row.id),
    acceptedAt: row.createdAt,
    replayed,
    deliveries: {
      queued,
      rejected,
      state: queued > 0 ? "QUEUED" : rejected > 0 ? "CONFIGURATION_ERROR" : "NONE_REQUESTED",
    },
  };
}

export async function persistFormSubmissionAndDeliveries(inputValue: PersistFormDeliveryInput) {
  const input = {
    ...inputValue,
    tenantId: validUuid(inputValue.tenantId, "INVALID_TENANT_ID"),
    websiteId: validUuid(inputValue.websiteId, "INVALID_WEBSITE_ID"),
    releaseId: validUuid(inputValue.releaseId, "INVALID_RELEASE_ID"),
    requestKey: requestKey(inputValue.requestKey),
  };
  const submissionRequestHash = hashSubmission(input);
  const plan = planTrustedDeliveryActions(input.actions);
  const traceId = input.requestId && UUID.test(input.requestId) ? input.requestId.toLowerCase() : randomUUID();

  return prisma.$transaction(async (tx: any) => {
    await ensurePlatformTenant(tx, input.tenantId, input.tenantId, "OWNER");
    const activeRelease = await tx.$queryRawUnsafe(
      `SELECT id FROM site_releases
       WHERE id=$1::uuid AND "websiteId"=$2::uuid AND status='ACTIVE'
       FOR SHARE`,
      input.releaseId,
      input.websiteId,
    ) as any[];
    if (!activeRelease[0]) {
      throw new AppError("Published form changed while submitting; please retry", 409, "PUBLISHED_RELEASE_CHANGED");
    }

    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO form_submissions(
         id,"websiteId","tenantId","releaseId","formId","formName",data,metadata,
         "idempotencyKey","requestHash","createdAt"
       ) VALUES(
         gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7::jsonb,$8,$9,NOW()
       )
       ON CONFLICT DO NOTHING
       RETURNING id,"createdAt"`,
      input.websiteId,
      input.tenantId,
      input.releaseId,
      input.formId,
      input.formName,
      JSON.stringify(input.fields),
      JSON.stringify(input.metadata),
      input.requestKey,
      submissionRequestHash,
    ) as any[];

    if (!inserted[0]) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id,"createdAt","requestHash"
         FROM form_submissions
         WHERE "websiteId"=$1::uuid AND "idempotencyKey"=$2
         LIMIT 1`,
        input.websiteId,
        input.requestKey,
      ) as any[];
      const row = existing[0];
      if (!row || String(row.requestHash) !== submissionRequestHash) {
        throw new AppError("Idempotency-Key was already used with a different submission", 409, "IDEMPOTENCY_KEY_REUSED");
      }
      const counts = await tx.$queryRawUnsafe(
        `SELECT
           (SELECT COUNT(*)::integer FROM platform.integration_delivery_resources
            WHERE tenant_id=$1::uuid AND submission_id=$2::uuid) AS queued,
           (SELECT COUNT(*)::integer FROM platform.integration_delivery_issues
            WHERE tenant_id=$1::uuid AND submission_id=$2::uuid) AS rejected`,
        input.tenantId,
        row.id,
      ) as any[];
      return publicResult(row, true, Number(counts[0]?.queued || 0), Number(counts[0]?.rejected || 0));
    }

    const submission = inserted[0];
    const payload = {
      websiteId: input.websiteId,
      releaseId: input.releaseId,
      submissionId: String(submission.id),
      formId: input.formId,
      formName: input.formName,
      fields: input.fields,
      metadata: input.metadata,
      acceptedAt: new Date(submission.createdAt).toISOString(),
    };
    const deliveryDeadline = deadline();

    for (const action of plan.actions) {
      const jobId = randomUUID();
      const eventId = randomUUID();
      const idempotencyKey = `form:${submission.id}:${action.actionName}:${action.actionIndex}`;
      const payloadRef = `integration:${jobId}`;
      const config = encryptDeliveryConfig(action.config, input.tenantId, jobId);
      const requestHash = deliveryHash({ payload, provider: action.provider, config: action.config });
      const task = {
        schemaVersion: 1,
        jobId,
        tenantId: input.tenantId,
        jobType: "integration.deliver",
        deadline: deliveryDeadline,
        traceId,
      };
      const event = {
        schemaVersion: 1,
        eventId,
        tenantId: input.tenantId,
        aggregateId: jobId,
        aggregateVersion: 0,
        type: "integration.status.v1",
        occurredAt: new Date().toISOString(),
        traceId,
        payload: {
          state: "ACCEPTED",
          provider: action.provider,
          actionType: action.type,
          websiteId: input.websiteId,
          submissionId: String(submission.id),
        },
      };

      await tx.$executeRawUnsafe(
        `INSERT INTO platform.jobs(
           tenant_id,id,job_type,idempotency_key,request_hash,payload_ref,trace_id,
           state,side_effects,max_attempts,deadline
         ) VALUES($1::uuid,$2::uuid,'integration.deliver',$3,$4,$5,$6::uuid,
                  'ACCEPTED','non-idempotent',8,$7::timestamptz)`,
        input.tenantId,
        jobId,
        idempotencyKey,
        requestHash,
        payloadRef,
        traceId,
        deliveryDeadline,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.integration_delivery_resources(
           tenant_id,job_id,website_id,release_id,submission_id,action_type,action_index,
           provider,payload,config_ciphertext,config_iv,config_tag,key_version
         ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
        input.tenantId,
        jobId,
        input.websiteId,
        input.releaseId,
        submission.id,
        action.type,
        action.actionIndex,
        action.provider,
        JSON.stringify(payload),
        config.ciphertext,
        config.iv,
        config.tag,
        config.keyVersion,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.outbox_events(
           tenant_id,event_id,aggregate_id,aggregate_version,event_type,body
         ) VALUES($1::uuid,$2::uuid,$3::uuid,0,'integration.status.v1',$4::jsonb)`,
        input.tenantId,
        eventId,
        jobId,
        JSON.stringify(event),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.outbox_deliveries(tenant_id,event_id,destination,body)
         VALUES($1::uuid,$2::uuid,'rabbitmq',$3::jsonb),
               ($1::uuid,$2::uuid,'kafka',$4::jsonb)`,
        input.tenantId,
        eventId,
        JSON.stringify(task),
        JSON.stringify(event),
      );
    }

    for (const issue of plan.rejected) {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.integration_delivery_issues(
           tenant_id,id,website_id,submission_id,action_name,code,details
         ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb)`,
        input.tenantId,
        randomUUID(),
        input.websiteId,
        submission.id,
        issue.actionName,
        issue.code,
        JSON.stringify(issue.details),
      );
    }

    return publicResult(submission, false, plan.actions.length, plan.rejected.length);
  });
}
