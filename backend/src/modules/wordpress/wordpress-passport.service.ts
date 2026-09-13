import { createHash } from "node:crypto";
import { prisma } from "../../config/prisma.js";
import { getWebsiteById } from "../../services/website.service.js";
import { AppError } from "../../utils/app-error.js";
import {
  buildCompatibilityPassport,
  type WordPressInventory,
  type WordPressSourceRecord,
} from "./compatibility.js";

const SOURCE_TYPE = /^(page|post|media|term)$/;

async function authorizeConnection(websiteId: string, connectionId: string, userId: string) {
  const website: any = await getWebsiteById(websiteId, userId);
  if (website.userPermission !== "OWNER" && website.userPermission !== "ADMIN") {
    throw new AppError("Only website owners and admins can inspect WordPress compatibility", 403, "WORDPRESS_FORBIDDEN");
  }
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id,"websiteId","siteUrl",status,capabilities
     FROM wordpress_connections
     WHERE id=$1::uuid AND "websiteId"=$2::uuid
     LIMIT 1`,
    connectionId,
    websiteId,
  );
  if (!rows[0]) throw new AppError("WordPress connection not found", 404, "WORDPRESS_CONNECTION_NOT_FOUND");
  if (rows[0].status === "REVOKED") throw new AppError("WordPress connection is revoked", 409, "WORDPRESS_CONNECTION_REVOKED");
  return rows[0];
}

function fingerprint(inventory: unknown, snapshots: Array<{ sourceType: string; sourceId: string; sourceHash: string }>): string {
  const ordered = snapshots
    .map((row) => ({ type: row.sourceType, id: row.sourceId, hash: row.sourceHash }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify({ inventory, snapshots: ordered })).digest("hex");
}

function publicPassport(row: any) {
  return {
    id: row.id,
    websiteId: row.websiteId,
    connectionId: row.connectionId,
    importRunId: row.importRunId,
    sourceFingerprint: row.sourceFingerprint,
    score: Number(row.score),
    grade: row.grade,
    migrationMode: row.migrationMode,
    summary: row.summary,
    findings: row.findings,
    createdAt: row.createdAt,
  };
}

export async function generateWordPressCompatibilityPassport(
  websiteId: string,
  connectionId: string,
  userId: string,
) {
  await authorizeConnection(websiteId, connectionId, userId);
  const imports = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id,summary,"completedAt"
     FROM wordpress_import_runs
     WHERE "websiteId"=$1::uuid AND "connectionId"=$2::uuid AND status='COMPLETED'
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    websiteId,
    connectionId,
  );
  const latestImport = imports[0];
  if (!latestImport) {
    throw new AppError("Run a WordPress read-only import before generating the compatibility passport", 409, "WORDPRESS_IMPORT_REQUIRED");
  }
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT "sourceType","sourceId","sourceHash",payload
     FROM wordpress_source_snapshots
     WHERE "websiteId"=$1::uuid AND "connectionId"=$2::uuid
     ORDER BY "sourceType","sourceId"
     LIMIT 10000`,
    websiteId,
    connectionId,
  );
  const sources: WordPressSourceRecord[] = rows.map((row) => ({
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    payload: row.payload,
  }));
  const inventory = (latestImport.summary?.inventory || {}) as WordPressInventory;
  const passport = buildCompatibilityPassport(inventory, sources);
  const sourceFingerprint = fingerprint(inventory, rows);
  const inserted = await prisma.$queryRawUnsafe<any[]>(
    `INSERT INTO wordpress_compatibility_passports(
       "websiteId","connectionId","importRunId","sourceFingerprint",score,grade,
       "migrationMode",summary,findings,"generatedBy"
     ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::uuid)
     ON CONFLICT("connectionId","sourceFingerprint") DO UPDATE SET
       score=EXCLUDED.score,grade=EXCLUDED.grade,"migrationMode"=EXCLUDED."migrationMode",
       summary=EXCLUDED.summary,findings=EXCLUDED.findings,"generatedBy"=EXCLUDED."generatedBy",
       "createdAt"=clock_timestamp()
     RETURNING id,"websiteId","connectionId","importRunId","sourceFingerprint",score,grade,
               "migrationMode",summary,findings,"createdAt"`,
    websiteId,
    connectionId,
    latestImport.id,
    sourceFingerprint,
    passport.score,
    passport.grade,
    passport.migrationMode,
    JSON.stringify(passport.summary),
    JSON.stringify(passport.findings),
    userId,
  );
  return publicPassport(inserted[0]);
}

export async function getLatestWordPressCompatibilityPassport(
  websiteId: string,
  connectionId: string,
  userId: string,
) {
  await authorizeConnection(websiteId, connectionId, userId);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id,"websiteId","connectionId","importRunId","sourceFingerprint",score,grade,
            "migrationMode",summary,findings,"createdAt"
     FROM wordpress_compatibility_passports
     WHERE "websiteId"=$1::uuid AND "connectionId"=$2::uuid
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    websiteId,
    connectionId,
  );
  return rows[0] ? publicPassport(rows[0]) : null;
}

export async function listWordPressSourceSnapshots(
  websiteId: string,
  connectionId: string,
  userId: string,
  sourceType?: string,
  limit = 100,
) {
  await authorizeConnection(websiteId, connectionId, userId);
  const bounded = Math.max(1, Math.min(500, Math.trunc(limit || 100)));
  const type = sourceType && SOURCE_TYPE.test(sourceType) ? sourceType : null;
  return prisma.$queryRawUnsafe<any[]>(
    `SELECT "sourceType","sourceId","sourceModified","sourceHash","firstSeenAt","lastSeenAt",
            payload->>'slug' AS slug,payload->>'status' AS status,
            COALESCE(payload->'title'->>'rendered',payload->'title'->>'raw','') AS title
     FROM wordpress_source_snapshots
     WHERE "websiteId"=$1::uuid AND "connectionId"=$2::uuid
       AND ($3::text IS NULL OR "sourceType"=$3)
     ORDER BY "lastSeenAt" DESC,"sourceId"
     LIMIT $4`,
    websiteId,
    connectionId,
    type,
    bounded,
  );
}
