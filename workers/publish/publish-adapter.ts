import { createHash } from "node:crypto";
import type { Adapter, DeliveryContext, DeliveryOutcome } from "../../packages/adapter-sdk/index.ts";
import { canonicalJson } from "../../packages/events/index.ts";
import type { SqlPool } from "../shared/postgres.ts";
import { tenantTransaction } from "../shared/postgres.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const REF = new RegExp(`^artifact:publish/(${UUID})/(\\d+)$`, "i");

export interface PublishPayloadReference {
  websiteId: string;
  sourceRevision: number;
}

export function parsePublishPayloadRef(value: string): PublishPayloadReference {
  const match = REF.exec(value);
  if (!match) throw new Error("INVALID_PUBLISH_PAYLOAD_REF");
  const sourceRevision = Number(match[2]);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
    throw new Error("INVALID_PUBLISH_PAYLOAD_REF");
  }
  return { websiteId: String(match[1]).toLowerCase(), sourceRevision };
}

export function releaseContentHash(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(payload, 16 * 1024 * 1024))
    .digest("hex");
}

const PERMANENT = new Set([
  "INVALID_PUBLISH_PAYLOAD_REF",
  "PUBLISH_RESOURCE_MISSING",
  "PUBLISH_RESOURCE_SCOPE_MISMATCH",
  "PUBLISH_SOURCE_REVISION_MISSING",
  "PUBLISH_RELEASE_CONFLICT",
  "PUBLISH_PAYLOAD_INVALID",
]);

export class PublishAdapter implements Adapter {
  readonly id = "forgestudio.database-release.v1";
  readonly sideEffects = "idempotent" as const;
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async deliver(context: DeliveryContext, payloadRef: string): Promise<DeliveryOutcome> {
    let reference: PublishPayloadReference;
    try {
      reference = parsePublishPayloadRef(payloadRef);
    } catch {
      return { status: "FAILED_PERMANENTLY", code: "INVALID_PUBLISH_PAYLOAD_REF" };
    }

    try {
      return await tenantTransaction(this.pool, context.tenantId, async (tx) => {
        const resources = await tx.query<{
          resource_id: string;
          source_revision: number | string;
          requested_by: string;
        }>(
          `SELECT resource_id,source_revision,requested_by
           FROM platform.job_resources
           WHERE tenant_id=$1 AND job_id=$2 AND resource_type='WEBSITE_PUBLISH'
           LIMIT 1`,
          [context.tenantId, context.jobId],
        );
        const resource = resources.rows[0];
        if (!resource) throw new Error("PUBLISH_RESOURCE_MISSING");
        if (
          resource.resource_id !== reference.websiteId ||
          Number(resource.source_revision) !== reference.sourceRevision
        ) {
          throw new Error("PUBLISH_RESOURCE_SCOPE_MISMATCH");
        }

        const sources = await tx.query<{
          id: string;
          name: string;
          slug: string;
          editorData: unknown;
        }>(
          `SELECT w.id,w.name,w.slug,r."editorData"
           FROM websites w
           JOIN website_revisions r
             ON r."websiteId"=w.id AND r.revision=$2
           WHERE w.id=$1::uuid
           FOR UPDATE OF w`,
          [reference.websiteId, reference.sourceRevision],
        );
        const source = sources.rows[0];
        if (!source) throw new Error("PUBLISH_SOURCE_REVISION_MISSING");

        const customCode = await tx.query(
          `SELECT id,name,title,"codeType",language,placement,location,scope,
                  "pageId",code,priority,conditions,status,"isEnabled","isActive","isDraft"
           FROM custom_code_snippets
           WHERE "websiteId"=$1::uuid AND "isEnabled"=true
             AND "isActive"=true AND "isDraft"=false
           ORDER BY priority DESC,id`,
          [reference.websiteId],
        );
        const themeRules = await tx.query(
          `SELECT id,"locationType","templateId",conditions,"isActive"
           FROM theme_location_rules
           WHERE "websiteId"=$1::uuid AND "isActive"=true
           ORDER BY id`,
          [reference.websiteId],
        );

        const payload = {
          website: {
            id: source.id,
            name: source.name,
            slug: source.slug,
            status: "PUBLISHED",
          },
          editorData: source.editorData,
          customCodeSnippets: customCode.rows,
          themeLocationRules: themeRules.rows,
        };
        let contentHash: string;
        try {
          contentHash = releaseContentHash(payload);
        } catch {
          throw new Error("PUBLISH_PAYLOAD_INVALID");
        }
        const requestKey = `publish-job:${context.jobId}`;
        const requestHash = releaseContentHash({
          jobId: context.jobId,
          sourceRevision: reference.sourceRevision,
          contentHash,
        });

        const existing = await tx.query<{
          id: string;
          releaseNumber: number | string;
          sourceRevision: number | string;
          contentHash: string;
          requestHash: string;
        }>(
          `SELECT id,"releaseNumber","sourceRevision","contentHash","requestHash"
           FROM site_releases
           WHERE "websiteId"=$1::uuid AND "requestKey"=$2
           LIMIT 1`,
          [reference.websiteId, requestKey],
        );
        if (existing.rows[0]) {
          const release = existing.rows[0];
          if (
            Number(release.sourceRevision) !== reference.sourceRevision ||
            release.contentHash !== contentHash ||
            release.requestHash !== requestHash
          ) {
            throw new Error("PUBLISH_RELEASE_CONFLICT");
          }
          return {
            status: "DELIVERED",
            receipt: `release:${release.id}:${release.releaseNumber}`,
          };
        }

        const sequence = await tx.query<{ next: number | string }>(
          `SELECT COALESCE(MAX("releaseNumber"),0)+1 AS next
           FROM site_releases WHERE "websiteId"=$1::uuid`,
          [reference.websiteId],
        );
        const releaseNumber = Number(sequence.rows[0]?.next);
        if (!Number.isSafeInteger(releaseNumber) || releaseNumber < 1) {
          throw new Error("PUBLISH_RELEASE_CONFLICT");
        }

        await tx.query(
          `UPDATE site_releases SET status='RETIRED'
           WHERE "websiteId"=$1::uuid AND status='ACTIVE'`,
          [reference.websiteId],
        );
        const inserted = await tx.query<{ id: string; releaseNumber: number | string }>(
          `INSERT INTO site_releases(
             "websiteId","releaseNumber","sourceRevision","requestKey","requestHash",
             "contentHash",payload,status,"createdBy","activatedAt"
           ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,'ACTIVE',$8::uuid,clock_timestamp())
           RETURNING id,"releaseNumber"`,
          [
            reference.websiteId,
            releaseNumber,
            reference.sourceRevision,
            requestKey,
            requestHash,
            contentHash,
            JSON.stringify(payload),
            resource.requested_by,
          ],
        );
        const release = inserted.rows[0];
        if (!release) throw new Error("PUBLISH_RELEASE_CONFLICT");
        await tx.query(
          `UPDATE websites SET status='PUBLISHED',"updatedAt"=clock_timestamp()
           WHERE id=$1::uuid`,
          [reference.websiteId],
        );
        return {
          status: "DELIVERED",
          receipt: `release:${release.id}:${release.releaseNumber}`,
        };
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "PUBLISH_ATTEMPT_FAILED";
      if (PERMANENT.has(code)) return { status: "FAILED_PERMANENTLY", code };
      throw error;
    }
  }
}
