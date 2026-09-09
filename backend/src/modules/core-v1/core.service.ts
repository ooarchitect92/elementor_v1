import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/app-error.js";
import { getWebsiteById } from "../../services/website.service.js";
import { canUserAccessResource } from "../../services/permission.service.js";

type JsonObject = Record<string, any>;

export interface SaveRevisionInput {
  expectedRevision: number;
  requestKey: string;
  editorData: JsonObject;
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out: JsonObject, key) => {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

export function contentHash(value: any): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function validateRequestKey(requestKey: string) {
  if (!/^[A-Za-z0-9:_-]{16,128}$/.test(requestKey)) {
    throw new AppError("requestKey must be 16-128 URL-safe characters", 400, "INVALID_REQUEST_KEY");
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {}));
}

const CONTENT_FIELDS = ["content", "src", "alt", "href", "title", "caption"] as const;

function mergeElementTree(
  currentElements: any[],
  incomingElements: any[],
  canEditDesign: boolean,
  isAdmin: boolean,
  allowedComponentIds: Set<string>
): any[] {
  const current = Array.isArray(currentElements) ? currentElements : [];
  const incoming = Array.isArray(incomingElements) ? incomingElements : [];
  const currentById = new Map(current.filter(Boolean).map((el: any) => [String(el.id), el]));
  const incomingById = new Map(incoming.filter(Boolean).map((el: any) => [String(el.id), el]));

  if (!canEditDesign) {
    return current.map((existing: any) => {
      const next = incomingById.get(String(existing.id));
      if (!next) return clone(existing);
      const merged = clone(existing);
      for (const field of CONTENT_FIELDS) {
        if (next[field] !== undefined) merged[field] = clone(next[field]);
      }
      if (Array.isArray(existing.children)) {
        merged.children = mergeElementTree(existing.children, next.children || [], false, isAdmin, allowedComponentIds);
      }
      return merged;
    });
  }

  const result: any[] = [];
  for (const next of incoming) {
    if (!next || next.id === undefined) continue;
    const previous = currentById.get(String(next.id));
    const protectedWithoutGrant = previous?.isProtected === true && !isAdmin && !allowedComponentIds.has(String(next.id));
    if (protectedWithoutGrant) {
      result.push(clone(previous));
      continue;
    }
    const merged = clone(next);
    if (previous?.children && Array.isArray(next.children)) {
      merged.children = mergeElementTree(previous.children, next.children, true, isAdmin, allowedComponentIds);
    }
    result.push(merged);
  }

  // A protected node omitted by an unauthorized collaborator cannot be deleted.
  for (const previous of current) {
    if (!previous?.id || incomingById.has(String(previous.id))) continue;
    if (previous.isProtected === true && !isAdmin && !allowedComponentIds.has(String(previous.id))) {
      result.push(clone(previous));
    }
  }
  return result;
}

function mergeEditorData(
  currentData: any,
  incomingData: any,
  canEditDesign: boolean,
  isAdmin: boolean,
  allowedComponentIds: Set<string>
): JsonObject {
  const current = clone(currentData || {});
  const incoming = clone(incomingData || {});
  const merged: JsonObject = canEditDesign ? { ...current, ...incoming } : { ...current };

  merged.elements = mergeElementTree(current.elements || [], incoming.elements || [], canEditDesign, isAdmin, allowedComponentIds);

  const currentPages = Array.isArray(current.pages) ? current.pages : [];
  const incomingPages = Array.isArray(incoming.pages) ? incoming.pages : [];
  if (canEditDesign) {
    const currentById = new Map(currentPages.map((p: any) => [String(p.id), p]));
    merged.pages = incomingPages.map((page: any) => {
      const previous: any = currentById.get(String(page.id));
      if (!previous) return clone(page);
      return {
        ...clone(page),
        elements: mergeElementTree(previous.elements || [], page.elements || [], true, isAdmin, allowedComponentIds),
      };
    });
  } else {
    const incomingById = new Map(incomingPages.map((p: any) => [String(p.id), p]));
    merged.pages = currentPages.map((page: any) => {
      const next: any = incomingById.get(String(page.id));
      return next ? { ...clone(page), elements: mergeElementTree(page.elements || [], next.elements || [], false, isAdmin, allowedComponentIds) } : clone(page);
    });
  }

  const currentPopups = Array.isArray(current.popups) ? current.popups : [];
  const incomingPopups = Array.isArray(incoming.popups) ? incoming.popups : [];
  if (canEditDesign) {
    const currentById = new Map(currentPopups.map((p: any) => [String(p.id), p]));
    merged.popups = incomingPopups.map((popup: any) => {
      const previous: any = currentById.get(String(popup.id));
      return previous ? { ...clone(popup), elements: mergeElementTree(previous.elements || [], popup.elements || [], true, isAdmin, allowedComponentIds) } : clone(popup);
    });
  } else {
    const incomingById = new Map(incomingPopups.map((p: any) => [String(p.id), p]));
    merged.popups = currentPopups.map((popup: any) => {
      const next: any = incomingById.get(String(popup.id));
      return next ? { ...clone(popup), elements: mergeElementTree(popup.elements || [], next.elements || [], false, isAdmin, allowedComponentIds) } : clone(popup);
    });
  }

  return merged;
}

async function editorAccess(websiteId: string, userId: string) {
  const website: any = await getWebsiteById(websiteId, userId);
  const permission = String(website.userPermission || "NONE");
  const isAdmin = permission === "OWNER" || permission === "ADMIN";
  const canEditDesign = isAdmin || await canUserAccessResource(userId, websiteId, "*", "EDIT_DESIGN");
  const canEditContent = canEditDesign || await canUserAccessResource(userId, websiteId, "*", "EDIT_CONTENT");
  if (!canEditContent) throw new AppError("You do not have edit permission", 403, "FORBIDDEN");
  return { website, permission, isAdmin, canEditDesign };
}

export async function getEditorState(websiteId: string, userId: string) {
  await getWebsiteById(websiteId, userId);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, name, slug, status, "editorData", "currentRevision", "updatedAt" FROM websites WHERE id=$1::uuid LIMIT 1`,
    websiteId,
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
  const requestHash = contentHash({ expectedRevision: input.expectedRevision, editorData: input.editorData });
  const accesses = await prisma.componentAccess.findMany({ where: { websiteId, userId }, select: { componentId: true } });
  const allowedIds = new Set(accesses.map((row) => String(row.componentId)));

  return prisma.$transaction(async (tx) => {
    const duplicate = await tx.$queryRawUnsafe<any[]>(
      `SELECT revision, "requestHash", "createdAt" FROM website_revisions WHERE "websiteId"=$1::uuid AND "requestKey"=$2 LIMIT 1`,
      websiteId, input.requestKey,
    );
    if (duplicate[0]) {
      if (duplicate[0].requestHash !== requestHash) {
        throw new AppError("requestKey was already used with a different payload", 409, "IDEMPOTENCY_KEY_REUSED");
      }
      return { revision: Number(duplicate[0].revision), persisted: true, duplicate: true, savedAt: duplicate[0].createdAt };
    }

    const rows = await tx.$queryRawUnsafe<any[]>(
      `SELECT "editorData", "currentRevision" FROM websites WHERE id=$1::uuid FOR UPDATE`, websiteId,
    );
    const current = rows[0];
    if (!current) throw new AppError("Website not found", 404, "WEBSITE_NOT_FOUND");
    const currentRevision = Number(current.currentRevision);
    if (currentRevision !== input.expectedRevision) {
      throw new AppError(`Revision conflict: current revision is ${currentRevision}`, 409, "REVISION_CONFLICT");
    }

    const editorData = mergeEditorData(current.editorData, input.editorData, access.canEditDesign, access.isAdmin, allowedIds);
    const nextRevision = currentRevision + 1;
    const updated = await tx.$queryRawUnsafe<any[]>(
      `UPDATE websites SET "editorData"=$1::jsonb, "currentRevision"=$2, "updatedAt"=NOW() WHERE id=$3::uuid AND "currentRevision"=$4 RETURNING "updatedAt"`,
      JSON.stringify(editorData), nextRevision, websiteId, currentRevision,
    );
    if (!updated[0]) throw new AppError("Revision changed while saving", 409, "REVISION_CONFLICT");

    await tx.$executeRawUnsafe(
      `INSERT INTO website_revisions ("websiteId",revision,"requestKey","requestHash","editorData","actorUserId") VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6::uuid)`,
      websiteId, nextRevision, input.requestKey, requestHash, JSON.stringify(editorData), userId,
    );
    return { revision: nextRevision, persisted: true, duplicate: false, savedAt: updated[0].updatedAt };
  });
}

export async function listRevisions(websiteId: string, userId: string, limit = 30) {
  await getWebsiteById(websiteId, userId);
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit || 30)));
  return prisma.$queryRawUnsafe<any[]>(
    `SELECT revision, "actorUserId", "createdAt" FROM website_revisions WHERE "websiteId"=$1::uuid ORDER BY revision DESC LIMIT $2`,
    websiteId, bounded,
  );
}

export async function getRevision(websiteId: string, userId: string, revision: number) {
  await getWebsiteById(websiteId, userId);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT revision, "editorData", "actorUserId", "createdAt" FROM website_revisions WHERE "websiteId"=$1::uuid AND revision=$2 LIMIT 1`,
    websiteId, revision,
  );
  if (!rows[0]) throw new AppError("Revision not found", 404, "REVISION_NOT_FOUND");
  return rows[0];
}

function requirePublisher(permission: string) {
  if (permission !== "OWNER" && permission !== "ADMIN") {
    throw new AppError("Only owners and admins can publish or roll back", 403, "PUBLISH_FORBIDDEN");
  }
}

export async function publishCurrentRevision(websiteId: string, userId: string, requestKey: string) {
  validateRequestKey(requestKey);
  const website: any = await getWebsiteById(websiteId, userId);
  requirePublisher(String(website.userPermission));

  return prisma.$transaction(async (tx) => {
    const siteRows = await tx.$queryRawUnsafe<any[]>(
      `SELECT id,name,slug,status,"editorData","currentRevision" FROM websites WHERE id=$1::uuid FOR UPDATE`, websiteId,
    );
    const site = siteRows[0];
    if (!site) throw new AppError("Website not found", 404, "WEBSITE_NOT_FOUND");

    const customCode = await tx.$queryRawUnsafe<any[]>(
      `SELECT id,name,title,"codeType",language,placement,location,scope,"pageId",code,priority,conditions,status,"isEnabled","isActive","isDraft" FROM custom_code_snippets WHERE "websiteId"=$1::uuid AND "isEnabled"=true AND "isActive"=true AND "isDraft"=false`, websiteId,
    );
    const themeRules = await tx.$queryRawUnsafe<any[]>(
      `SELECT id,"locationType","templateId",conditions,"isActive" FROM theme_location_rules WHERE "websiteId"=$1::uuid AND "isActive"=true`, websiteId,
    );
    const payload = {
      website: { id: site.id, name: site.name, slug: site.slug, status: "PUBLISHED" },
      editorData: site.editorData,
      customCodeSnippets: customCode,
      themeLocationRules: themeRules,
    };
    const sourceRevision = Number(site.currentRevision);
    const requestHash = contentHash({ sourceRevision, payload });
    const hash = contentHash(payload);

    const duplicate = await tx.$queryRawUnsafe<any[]>(
      `SELECT id,"releaseNumber","sourceRevision","contentHash",status,"activatedAt" FROM site_releases WHERE "websiteId"=$1::uuid AND "requestKey"=$2 LIMIT 1`,
      websiteId, requestKey,
    );
    if (duplicate[0]) {
      const stored = await tx.$queryRawUnsafe<any[]>(`SELECT "requestHash" FROM site_releases WHERE id=$1::uuid`, duplicate[0].id);
      if (stored[0]?.requestHash !== requestHash) throw new AppError("requestKey was already used with a different release", 409, "IDEMPOTENCY_KEY_REUSED");
      return { ...duplicate[0], duplicate: true };
    }

    const sequence = await tx.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(MAX("releaseNumber"),0)+1 AS next FROM site_releases WHERE "websiteId"=$1::uuid`, websiteId,
    );
    const releaseNumber = Number(sequence[0].next);
    await tx.$executeRawUnsafe(`UPDATE site_releases SET status='RETIRED' WHERE "websiteId"=$1::uuid AND status='ACTIVE'`, websiteId);
    const release = await tx.$queryRawUnsafe<any[]>(
      `INSERT INTO site_releases ("websiteId","releaseNumber","sourceRevision","requestKey","requestHash","contentHash",payload,status,"createdBy","activatedAt") VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,'ACTIVE',$8::uuid,NOW()) RETURNING id,"releaseNumber","sourceRevision","contentHash",status,"activatedAt","createdAt"`,
      websiteId, releaseNumber, sourceRevision, requestKey, requestHash, hash, JSON.stringify(payload), userId,
    );
    await tx.$executeRawUnsafe(`UPDATE websites SET status='PUBLISHED', "updatedAt"=NOW() WHERE id=$1::uuid`, websiteId);
    return { ...release[0], duplicate: false };
  });
}

export async function listReleases(websiteId: string, userId: string) {
  await getWebsiteById(websiteId, userId);
  return prisma.$queryRawUnsafe<any[]>(
    `SELECT id,"releaseNumber","sourceRevision","contentHash",status,"createdBy","createdAt","activatedAt" FROM site_releases WHERE "websiteId"=$1::uuid ORDER BY "releaseNumber" DESC LIMIT 100`, websiteId,
  );
}

export async function activateRelease(websiteId: string, userId: string, releaseId: string) {
  const website: any = await getWebsiteById(websiteId, userId);
  requirePublisher(String(website.userPermission));
  return prisma.$transaction(async (tx) => {
    const target = await tx.$queryRawUnsafe<any[]>(
      `SELECT id,"releaseNumber","sourceRevision","contentHash" FROM site_releases WHERE id=$1::uuid AND "websiteId"=$2::uuid FOR UPDATE`, releaseId, websiteId,
    );
    if (!target[0]) throw new AppError("Release not found", 404, "RELEASE_NOT_FOUND");
    await tx.$executeRawUnsafe(`UPDATE site_releases SET status='RETIRED' WHERE "websiteId"=$1::uuid AND status='ACTIVE'`, websiteId);
    const activated = await tx.$queryRawUnsafe<any[]>(
      `UPDATE site_releases SET status='ACTIVE',"activatedAt"=NOW() WHERE id=$1::uuid RETURNING id,"releaseNumber","sourceRevision","contentHash",status,"activatedAt"`, releaseId,
    );
    await tx.$executeRawUnsafe(`UPDATE websites SET status='PUBLISHED',"updatedAt"=NOW() WHERE id=$1::uuid`, websiteId);
    return activated[0];
  });
}

export async function getActivePublishedSite(websiteId: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT r.id AS "releaseId",r."releaseNumber",r."sourceRevision",r."contentHash",r."activatedAt",r.payload FROM site_releases r WHERE r."websiteId"=$1::uuid AND r.status='ACTIVE' LIMIT 1`, websiteId,
  );
  if (!rows[0]) throw new AppError("Published site not found", 404, "PUBLISHED_SITE_NOT_FOUND");
  return rows[0];
}
