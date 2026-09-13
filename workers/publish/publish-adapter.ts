import { createHash } from "node:crypto";
import type { Adapter, DeliveryContext, DeliveryOutcome } from "../../packages/adapter-sdk/index.ts";
import { canonicalJson } from "../../packages/events/index.ts";
import type { SqlPool } from "../shared/postgres.ts";
import { tenantTransaction } from "../shared/postgres.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const REF = new RegExp(`^artifact:publish/(${UUID})/(\\d+)$`, "i");

export interface PublishPayloadReference { websiteId: string; sourceRevision: number }

export function parsePublishPayloadRef(value: string): PublishPayloadReference {
  const match = REF.exec(value);
  if (!match) throw new Error("INVALID_PUBLISH_PAYLOAD_REF");
  const sourceRevision = Number(match[2]);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw new Error("INVALID_PUBLISH_PAYLOAD_REF");
  return { websiteId: String(match[1]).toLowerCase(), sourceRevision };
}

export function releaseContentHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload, 16 * 1024 * 1024)).digest("hex");
}

const PERMANENT = new Set([
  "INVALID_PUBLISH_PAYLOAD_REF",
  "PUBLISH_RESOURCE_MISSING",
  "PUBLISH_RESOURCE_SCOPE_MISMATCH",
  "PUBLISH_SNAPSHOT_INVALID",
  "PUBLISH_SNAPSHOT_HASH_MISMATCH",
  "PUBLISH_RELEASE_CONFLICT",
  "PUBLISH_SUPERSEDED",
]);

export class PublishAdapter implements Adapter {
  readonly id = "forgestudio.database-release.v1";
  readonly sideEffects = "idempotent" as const;
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

  async deliver(context: DeliveryContext, payloadRef: string): Promise<DeliveryOutcome> {
    let reference: PublishPayloadReference;
    try { reference = parsePublishPayloadRef(payloadRef); }
    catch { return { status: "FAILED_PERMANENTLY", code: "INVALID_PUBLISH_PAYLOAD_REF" }; }

    try {
      return await tenantTransaction(this.pool, context.tenantId, async (tx) => {
        const resources = await tx.query<{
          resource_id: string;
          source_revision: number | string;
          source_hash: string;
          source_payload: unknown;
          requested_by: string;
          created_at: string | Date;
        }>(
          `SELECT resource_id,source_revision,source_hash,source_payload,requested_by,created_at
           FROM platform.job_resources
           WHERE tenant_id=$1 AND job_id=$2 AND resource_type='WEBSITE_PUBLISH' LIMIT 1`,
          [context.tenantId, context.jobId],
        );
        const resource = resources.rows[0];
        if (!resource) throw new Error("PUBLISH_RESOURCE_MISSING");
        if (resource.resource_id !== reference.websiteId || Number(resource.source_revision) !== reference.sourceRevision) {
          throw new Error("PUBLISH_RESOURCE_SCOPE_MISMATCH");
        }
        const payload = resource.source_payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("PUBLISH_SNAPSHOT_INVALID");
        const website = (payload as Record<string, any>).website;
        if (!website || String(website.id) !== reference.websiteId) throw new Error("PUBLISH_SNAPSHOT_INVALID");
        const contentHash = releaseContentHash(payload);
        if (contentHash !== resource.source_hash) throw new Error("PUBLISH_SNAPSHOT_HASH_MISMATCH");
        const acceptedAt = new Date(resource.created_at).getTime();
        if (!Number.isFinite(acceptedAt)) throw new Error("PUBLISH_SNAPSHOT_INVALID");

        const lockedSite = await tx.query<{ id: string }>(
          `SELECT id FROM websites WHERE id=$1::uuid FOR UPDATE`, [reference.websiteId],
        );
        if (!lockedSite.rows[0]) throw new Error("PUBLISH_RESOURCE_MISSING");

        const requestKey = `publish-job:${context.jobId}`;
        const requestHash = releaseContentHash({
          jobId: context.jobId,
          sourceRevision: reference.sourceRevision,
          sourceHash: resource.source_hash,
        });
        const existing = await tx.query<{
          id: string; releaseNumber: number | string; sourceRevision: number | string;
          contentHash: string; requestHash: string;
        }>(
          `SELECT id,"releaseNumber","sourceRevision","contentHash","requestHash"
           FROM site_releases WHERE "websiteId"=$1::uuid AND "requestKey"=$2 LIMIT 1`,
          [reference.websiteId, requestKey],
        );
        if (existing.rows[0]) {
          const release = existing.rows[0];
          if (Number(release.sourceRevision) !== reference.sourceRevision || release.contentHash !== contentHash || release.requestHash !== requestHash) {
            throw new Error("PUBLISH_RELEASE_CONFLICT");
          }
          return { status: "DELIVERED", receipt: `release:${release.id}:${release.releaseNumber}` };
        }

        const active = await tx.query<{
          id: string; requestAcceptedAt: string | Date;
        }>(
          `SELECT id,"requestAcceptedAt" FROM site_releases
           WHERE "websiteId"=$1::uuid AND status='ACTIVE' LIMIT 1`,
          [reference.websiteId],
        );
        const activeAcceptedAt = active.rows[0] ? new Date(active.rows[0].requestAcceptedAt).getTime() : 0;
        if (Number.isFinite(activeAcceptedAt) && activeAcceptedAt > acceptedAt) throw new Error("PUBLISH_SUPERSEDED");

        const sequence = await tx.query<{ next: number | string }>(
          `SELECT COALESCE(MAX("releaseNumber"),0)+1 AS next FROM site_releases WHERE "websiteId"=$1::uuid`,
          [reference.websiteId],
        );
        const releaseNumber = Number(sequence.rows[0]?.next);
        if (!Number.isSafeInteger(releaseNumber) || releaseNumber < 1) throw new Error("PUBLISH_RELEASE_CONFLICT");

        await tx.query(`UPDATE site_releases SET status='RETIRED' WHERE "websiteId"=$1::uuid AND status='ACTIVE'`, [reference.websiteId]);
        const inserted = await tx.query<{ id: string; releaseNumber: number | string }>(
          `INSERT INTO site_releases(
             "websiteId","releaseNumber","sourceRevision","requestKey","requestHash","contentHash",
             payload,status,"createdBy","requestAcceptedAt","activatedAt"
           ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,'ACTIVE',$8::uuid,$9::timestamptz,clock_timestamp())
           RETURNING id,"releaseNumber"`,
          [reference.websiteId, releaseNumber, reference.sourceRevision, requestKey, requestHash,
           contentHash, JSON.stringify(payload), resource.requested_by, resource.created_at],
        );
        const release = inserted.rows[0];
        if (!release) throw new Error("PUBLISH_RELEASE_CONFLICT");
        await tx.query(`UPDATE websites SET status='PUBLISHED',"updatedAt"=clock_timestamp() WHERE id=$1::uuid`, [reference.websiteId]);
        return { status: "DELIVERED", receipt: `release:${release.id}:${release.releaseNumber}` };
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "PUBLISH_ATTEMPT_FAILED";
      if (PERMANENT.has(code)) return { status: "FAILED_PERMANENTLY", code };
      throw error;
    }
  }
}
