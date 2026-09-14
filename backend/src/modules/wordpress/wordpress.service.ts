import crypto from "node:crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/app-error.js";
import { getWebsiteById } from "../../services/website.service.js";
import { pinnedJsonRequest } from "./safe-http.js";

interface PairInput { siteUrl: string; username: string; applicationPassword: string }

function requireAdminPermission(permission: string) {
  if (permission !== "OWNER" && permission !== "ADMIN") {
    throw new AppError("Only website owners and admins can manage WordPress connections", 403, "WORDPRESS_FORBIDDEN");
  }
}

async function authorize(websiteId: string, userId: string) {
  const website: any = await getWebsiteById(websiteId, userId);
  requireAdminPermission(String(website.userPermission));
  return website;
}

function encryptionKey(): Buffer {
  const encoded = process.env.WORDPRESS_SECRET_KEY_BASE64 || "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new AppError("WordPress secret encryption is not configured", 503, "WORDPRESS_SECRET_KEY_NOT_CONFIGURED");
  }
  return key;
}

function encryptSecret(secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decryptSecret(row: any): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(row.secretIv, "base64"));
  decipher.setAuthTag(Buffer.from(row.secretTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.secretCiphertext, "base64")), decipher.final()]).toString("utf8");
}

function normalizeSiteUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError("Invalid WordPress site URL", 400, "WORDPRESS_INVALID_URL"); }
  if (url.protocol !== "https:") throw new AppError("WordPress connections require HTTPS", 400, "WORDPRESS_HTTPS_REQUIRED");
  if (url.search || url.hash) throw new AppError("WordPress site URL cannot contain query or fragment", 400, "WORDPRESS_INVALID_URL");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function authHeader(username: string, applicationPassword: string) {
  return `Basic ${Buffer.from(`${username}:${applicationPassword}`, "utf8").toString("base64")}`;
}

async function connectorCapabilities(siteUrl: string, username: string, password: string) {
  const response = await pinnedJsonRequest<any>(`${siteUrl}/wp-json/forgestudio/v1/capabilities`, { Authorization: authHeader(username, password) });
  if (response.status === 401 || response.status === 403) throw new AppError("WordPress connector credentials or permissions were rejected", 400, "WORDPRESS_AUTH_REJECTED");
  if (response.status !== 200 || response.body?.contract_version !== 1 || response.body?.capabilities?.inspect !== true) {
    throw new AppError("ForgeStudio Connect is missing or incompatible", 400, "WORDPRESS_CONNECTOR_INCOMPATIBLE");
  }
  return response.body;
}

function publicConnection(row: any) {
  return {
    id: row.id,
    websiteId: row.websiteId,
    siteUrl: row.siteUrl,
    username: row.username,
    capabilities: row.capabilities,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function pairWordPress(websiteId: string, userId: string, input: PairInput) {
  await authorize(websiteId, userId);
  const siteUrl = normalizeSiteUrl(String(input.siteUrl || ""));
  const username = String(input.username || "").trim();
  const password = String(input.applicationPassword || "").trim();
  if (!username || username.length > 200 || !password || password.length > 500) {
    throw new AppError("Username and Application Password are required", 400, "WORDPRESS_CREDENTIALS_REQUIRED");
  }
  const capabilities = await connectorCapabilities(siteUrl, username, password);
  if (capabilities?.capabilities?.pairing !== true) {
    throw new AppError("This ForgeStudio Connect version does not support pairing", 400, "WORDPRESS_PAIRING_UNSUPPORTED");
  }
  const encrypted = encryptSecret(password);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `INSERT INTO wordpress_connections ("websiteId","siteUrl",username,"secretCiphertext","secretIv","secretTag",capabilities,status,"lastCheckedAt","createdBy")
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,'ACTIVE',NOW(),$8::uuid)
     ON CONFLICT ("websiteId","siteUrl") DO UPDATE SET username=EXCLUDED.username,"secretCiphertext"=EXCLUDED."secretCiphertext","secretIv"=EXCLUDED."secretIv","secretTag"=EXCLUDED."secretTag",capabilities=EXCLUDED.capabilities,status='ACTIVE',"lastCheckedAt"=NOW(),"updatedAt"=NOW()
     RETURNING id,"websiteId","siteUrl",username,capabilities,status,"lastCheckedAt","createdAt","updatedAt"`,
    websiteId, siteUrl, username, encrypted.ciphertext, encrypted.iv, encrypted.tag, JSON.stringify(capabilities), userId,
  );
  return publicConnection(rows[0]);
}

export async function listWordPressConnections(websiteId: string, userId: string) {
  await authorize(websiteId, userId);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id,"websiteId","siteUrl",username,capabilities,status,"lastCheckedAt","createdAt","updatedAt" FROM wordpress_connections WHERE "websiteId"=$1::uuid ORDER BY "createdAt" DESC`, websiteId,
  );
  return rows.map(publicConnection);
}

async function privateConnection(websiteId: string, connectionId: string, userId: string) {
  await authorize(websiteId, userId);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM wordpress_connections WHERE id=$1::uuid AND "websiteId"=$2::uuid LIMIT 1`, connectionId, websiteId,
  );
  if (!rows[0]) throw new AppError("WordPress connection not found", 404, "WORDPRESS_CONNECTION_NOT_FOUND");
  if (rows[0].status === "REVOKED") throw new AppError("WordPress connection is revoked", 409, "WORDPRESS_CONNECTION_REVOKED");
  return rows[0];
}

export async function checkWordPressConnection(websiteId: string, connectionId: string, userId: string) {
  const connection = await privateConnection(websiteId, connectionId, userId);
  try {
    const capabilities = await connectorCapabilities(connection.siteUrl, connection.username, decryptSecret(connection));
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `UPDATE wordpress_connections SET capabilities=$1::jsonb,status='ACTIVE',"lastCheckedAt"=NOW(),"updatedAt"=NOW() WHERE id=$2::uuid RETURNING id,"websiteId","siteUrl",username,capabilities,status,"lastCheckedAt","createdAt","updatedAt"`,
      JSON.stringify(capabilities), connectionId,
    );
    return publicConnection(rows[0]);
  } catch (error) {
    await prisma.$executeRawUnsafe(`UPDATE wordpress_connections SET status='ERROR',"lastCheckedAt"=NOW(),"updatedAt"=NOW() WHERE id=$1::uuid`, connectionId);
    throw error;
  }
}

export async function revokeWordPressConnection(websiteId: string, connectionId: string, userId: string) {
  await authorize(websiteId, userId);
  const result = await prisma.$executeRawUnsafe(
    `UPDATE wordpress_connections SET status='REVOKED',"secretCiphertext"='',"secretIv"='',"secretTag"='',"updatedAt"=NOW() WHERE id=$1::uuid AND "websiteId"=$2::uuid`,
    connectionId, websiteId,
  );
  if (result === 0) throw new AppError("WordPress connection not found", 404, "WORDPRESS_CONNECTION_NOT_FOUND");
  return { revoked: true };
}

async function fetchCollection(connection: any, type: "pages" | "posts", maxItems: number) {
  const password = decryptSecret(connection);
  const headers = { Authorization: authHeader(connection.username, password) };
  const items: any[] = [];
  const perPage = 100;
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && items.length < maxItems) {
    const response = await pinnedJsonRequest<any[]>(
      `${connection.siteUrl}/wp-json/wp/v2/${type}?context=edit&per_page=${perPage}&page=${page}&_fields=id,date_gmt,modified_gmt,slug,status,title,content,excerpt,parent,menu_order,template,featured_media,link`,
      headers,
      { maxBytes: 8 * 1024 * 1024 },
    );
    if (response.status === 401 || response.status === 403) throw new AppError("WordPress import permission was rejected", 400, "WORDPRESS_IMPORT_FORBIDDEN");
    if (response.status !== 200 || !Array.isArray(response.body)) throw new AppError(`WordPress ${type} import failed`, 502, "WORDPRESS_IMPORT_FAILED");
    items.push(...response.body.slice(0, Math.max(0, maxItems - items.length)));
    totalPages = Math.max(1, Math.min(100, Number(response.headers["x-wp-totalpages"] || 1)));
    page += 1;
  }
  return items;
}

export async function importWordPressSnapshot(websiteId: string, connectionId: string, userId: string, maxItems = 1000) {
  const connection = await privateConnection(websiteId, connectionId, userId);
  if (connection.capabilities?.capabilities?.import !== true) {
    throw new AppError("Connector does not advertise read-only import support", 409, "WORDPRESS_IMPORT_UNSUPPORTED");
  }
  const boundedMax = Math.max(1, Math.min(2000, Math.trunc(maxItems || 1000)));
  const runId = crypto.randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO wordpress_import_runs (id,"websiteId","connectionId",status,"createdBy") VALUES ($1::uuid,$2::uuid,$3::uuid,'RUNNING',$4::uuid)`,
    runId, websiteId, connectionId, userId,
  );
  try {
    const [pages, posts, inventory] = await Promise.all([
      fetchCollection(connection, "pages", boundedMax),
      fetchCollection(connection, "posts", boundedMax),
      pinnedJsonRequest<any>(`${connection.siteUrl}/wp-json/forgestudio/v1/inventory`, { Authorization: authHeader(connection.username, decryptSecret(connection)) }),
    ]);
    const records = [...pages.map((payload) => ({ type: "page", payload })), ...posts.map((payload) => ({ type: "post", payload }))];
    let changed = 0;
    await prisma.$transaction(async (tx) => {
      for (const record of records) {
        const sourceId = String(record.payload.id);
        const hash = crypto.createHash("sha256").update(JSON.stringify(record.payload)).digest("hex");
        const existing = await tx.$queryRawUnsafe<any[]>(
          `SELECT "sourceHash" FROM wordpress_source_snapshots WHERE "connectionId"=$1::uuid AND "sourceType"=$2 AND "sourceId"=$3 LIMIT 1`,
          connectionId, record.type, sourceId,
        );
        if (existing[0]?.sourceHash !== hash) changed += 1;
        await tx.$executeRawUnsafe(
          `INSERT INTO wordpress_source_snapshots ("connectionId","websiteId","sourceType","sourceId","sourceModified","sourceHash",payload,"lastSeenAt")
           VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb,NOW())
           ON CONFLICT ("connectionId","sourceType","sourceId") DO UPDATE SET "sourceModified"=EXCLUDED."sourceModified","sourceHash"=EXCLUDED."sourceHash",payload=EXCLUDED.payload,"lastSeenAt"=NOW()`,
          connectionId, websiteId, record.type, sourceId, record.payload.modified_gmt || null, hash, JSON.stringify(record.payload),
        );
      }
      const summary = { pages: pages.length, posts: posts.length, changed, inventory: inventory.status === 200 ? inventory.body : null };
      await tx.$executeRawUnsafe(
        `UPDATE wordpress_import_runs SET status='COMPLETED',summary=$1::jsonb,"completedAt"=NOW() WHERE id=$2::uuid`, JSON.stringify(summary), runId,
      );
    });
    return { runId, status: "COMPLETED", pages: pages.length, posts: posts.length, changed };
  } catch (error) {
    await prisma.$executeRawUnsafe(
      `UPDATE wordpress_import_runs SET status='FAILED',"errorCode"=$1,"completedAt"=NOW() WHERE id=$2::uuid`,
      error instanceof AppError ? error.code : "WORDPRESS_IMPORT_FAILED", runId,
    );
    throw error;
  }
}

export async function listWordPressImports(websiteId: string, connectionId: string, userId: string) {
  await privateConnection(websiteId, connectionId, userId);
  return prisma.$queryRawUnsafe<any[]>(
    `SELECT id,status,summary,"errorCode","createdAt","completedAt" FROM wordpress_import_runs WHERE "websiteId"=$1::uuid AND "connectionId"=$2::uuid ORDER BY "createdAt" DESC LIMIT 50`,
    websiteId, connectionId,
  );
}
