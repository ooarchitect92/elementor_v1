import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/app-error.js";
import { getWebsiteById } from "../../services/website.service.js";
import { canUserAccessResource } from "../../services/permission.service.js";
import { contentHash, mergeEditorData } from "./editor-merge.js";
import { redactPublicReleasePayload } from "./release-privacy.js";

type JsonObject = Record<string, any>;
export interface SaveRevisionInput {
  expectedRevision: number;
  requestKey: string;
  editorData: JsonObject;
  performanceSettings?: any;
}

function validateRequestKey(requestKey: string) {
  if (!/^[A-Za-z0-9:_-]{16,128}$/.test(requestKey)) {
    throw new AppError("requestKey must be 16-128 URL-safe characters", 400, "INVALID_REQUEST_KEY");
  }
}

async function editorAccess(websiteId: string, userId: string) {
  const website: any = await getWebsiteById(websiteId, userId);
  const permission = String(website.userPermission || "NONE");
  const isAdmin = permission === "OWNER" || permission === "ADMIN";
  const canEditDesign = isAdmin || await canUserAccessResource(userId, websiteId, "*", "EDIT_DESIGN");
  const canEditContent = canEditDesign || await canUserAccessResource(userId, websiteId, "*", "EDIT_CONTENT");
  if (!canEditContent) throw new AppError("You do not have edit permission", 403, "FORBIDDEN");
  return { website, isAdmin, canEditDesign };
}

export async function getEditorState(websiteId: string, userId: string) {
  await getWebsiteById(websiteId, userId);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id,name,slug,status,"editorData","performanceSettings","currentRevision","updatedAt"
     FROM websites WHERE id=$1::uuid LIMIT 1`, websiteId,
  );
  if (!rows[0]) throw new AppError("Website not found", 404, "WEBSITE_NOT_FOUND");
  return rows[0];
}

export async function saveEditorRevision(websiteId: string, userId: string, input: SaveRevisionInput) {
  validateRequestKey(input.requestKey);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new AppError("expectedRevision must be a non-negative integer", 400, "INVALID_REVISION");
  }
  if (!input.editorData || typeof input.editorData !== "object" || Array.isArray(input.editorData)) {
    throw new AppError("editorData must be an object", 400, "INVALID_EDITOR_DATA");
  }
  const access = await editorAccess(websiteId, userId);
  const requestHash = contentHash({ expectedRevision: input.expectedRevision, editorData: input.editorData, performanceSettings: input.performanceSettings });
  const accesses = await prisma.componentAccess.findMany({ where: { websiteId, userId }, select: { componentId: true } });
  const allowedIds = new Set(accesses.map((row) => String(row.componentId)));

  return prisma.$transaction(async (tx) => {
    const duplicate = await tx.$queryRawUnsafe<any[]>(
      `SELECT revision,"requestHash","createdAt" FROM website_revisions
       WHERE "websiteId"=$1::uuid AND "requestKey"=$2 LIMIT 1`, websiteId, input.requestKey,
    );
    if (duplicate[0]) {
      if (duplicate[0].requestHash !== requestHash) throw new AppError("requestKey was already used with a different payload", 409, "IDEMPOTENCY_KEY_REUSED");
      return { revision: Number(duplicate[0].revision), persisted: true, duplicate: true, savedAt: duplicate[0].createdAt };
    }
    const rows = await tx.$queryRawUnsafe<any[]>(
      `SELECT "editorData","performanceSettings","currentRevision" FROM websites WHERE id=$1::uuid FOR UPDATE`, websiteId,
    );
    const current = rows[0];
    if (!current) throw new AppError("Website not found", 404, "WEBSITE_NOT_FOUND");
    const currentRevision = Number(current.currentRevision);
    if (currentRevision !== input.expectedRevision) throw new AppError(`Revision conflict: current revision is ${currentRevision}`, 409, "REVISION_CONFLICT");

    const editorData = mergeEditorData(current.editorData, input.editorData, access.canEditDesign, access.isAdmin, allowedIds);
    const performanceSettings = access.canEditDesign && input.performanceSettings !== undefined ? input.performanceSettings : current.performanceSettings;
    const nextRevision = currentRevision + 1;
    const updated = await tx.$queryRawUnsafe<any[]>(
      `UPDATE websites SET "editorData"=$1::jsonb,"performanceSettings"=$2::jsonb,
       "currentRevision"=$3,"updatedAt"=NOW()
       WHERE id=$4::uuid AND "currentRevision"=$5 RETURNING "updatedAt"`,
      JSON.stringify(editorData), JSON.stringify(performanceSettings ?? {}), nextRevision, websiteId, currentRevision,
    );
    if (!updated[0]) throw new AppError("Revision changed while saving", 409, "REVISION_CONFLICT");
    await tx.$executeRawUnsafe(
      `INSERT INTO website_revisions
       ("websiteId",revision,"requestKey","requestHash","editorData","performanceSettings","actorUserId")
       VALUES($1::uuid,$2,$3,$4,$5::jsonb,$6::jsonb,$7::uuid)`,
      websiteId, nextRevision, input.requestKey, requestHash,
      JSON.stringify(editorData), JSON.stringify(performanceSettings ?? {}), userId,
    );
    return { revision: nextRevision, persisted: true, duplicate: false, savedAt: updated[0].updatedAt };
  });
}

export async function listRevisions(websiteId: string, userId: string, limit = 30) {
  await getWebsiteById(websiteId, userId);
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit || 30)));
  return prisma.$queryRawUnsafe<any[]>(
    `SELECT revision,"actorUserId","createdAt" FROM website_revisions
     WHERE "websiteId"=$1::uuid ORDER BY revision DESC LIMIT $2`, websiteId, bounded,
  );
}

export async function getRevision(websiteId: string, userId: string, revision: number) {
  await getWebsiteById(websiteId, userId);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT revision,"editorData","performanceSettings","actorUserId","createdAt"
     FROM website_revisions WHERE "websiteId"=$1::uuid AND revision=$2 LIMIT 1`, websiteId, revision,
  );
  if (!rows[0]) throw new AppError("Revision not found", 404, "REVISION_NOT_FOUND");
  return rows[0];
}

export async function listReleases(websiteId: string, userId: string) {
  await getWebsiteById(websiteId, userId);
  return prisma.$queryRawUnsafe<any[]>(
    `SELECT id,"releaseNumber","sourceRevision","contentHash",status,"createdBy","createdAt","activatedAt"
     FROM site_releases WHERE "websiteId"=$1::uuid ORDER BY "releaseNumber" DESC LIMIT 100`, websiteId,
  );
}

export async function getActivePublishedSite(websiteId: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT r.id AS "releaseId",r."releaseNumber",r."sourceRevision",r."activatedAt",r.payload
     FROM site_releases r WHERE r."websiteId"=$1::uuid AND r.status='ACTIVE' LIMIT 1`, websiteId,
  );
  if (!rows[0]) throw new AppError("Published site not found", 404, "PUBLISHED_SITE_NOT_FOUND");
  try {
    const payload = redactPublicReleasePayload(rows[0].payload);
    return { ...rows[0], payload, contentHash: contentHash(payload) };
  } catch {
    throw new AppError("Published release cannot be safely rendered", 503, "PUBLISHED_RELEASE_UNSAFE");
  }
}
