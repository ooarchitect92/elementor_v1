import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export type ObjectBody = Uint8Array | string;

export interface PutObjectInput {
  key: string;
  body: ObjectBody;
  contentType: string;
  cacheControl?: string;
  metadata?: Readonly<Record<string, string>>;
  expectedSha256?: string;
  ifNoneMatch?: boolean;
}

export interface StoredObject {
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
  metadata: Readonly<Record<string, string>>;
  sha256: string;
  etag: string;
  size: number;
  updatedAt: string;
}

export interface ObjectHead extends Omit<StoredObject, "body"> {}

export interface ObjectStore {
  put(input: PutObjectInput): Promise<ObjectHead>;
  get(key: string): Promise<StoredObject>;
  head(key: string): Promise<ObjectHead | null>;
  delete(key: string): Promise<void>;
  copy(sourceKey: string, destination: Omit<PutObjectInput, "body">): Promise<ObjectHead>;
  presignPut?(input: Omit<PutObjectInput, "body">, expiresSeconds: number): Promise<string>;
  presignGet?(key: string, expiresSeconds: number): Promise<string>;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._~!$&'()+,;=@/-]{0,1023}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function objectKey(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const parts = normalized.split("/");
  if (!SAFE_KEY.test(normalized) || normalized.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("INVALID_OBJECT_KEY");
  }
  return normalized;
}

export function sha256(body: ObjectBody): string {
  return createHash("sha256").update(typeof body === "string" ? Buffer.from(body, "utf8") : body).digest("hex");
}

function bytes(body: ObjectBody): Uint8Array {
  return typeof body === "string" ? Buffer.from(body, "utf8") : body;
}

function validatePut(input: PutObjectInput): { key: string; body: Uint8Array; hash: string } {
  const key = objectKey(input.key);
  if (!/^[-\w.+/;=:@]{1,255}$/.test(input.contentType)) throw new Error("INVALID_CONTENT_TYPE");
  const body = bytes(input.body);
  const hash = sha256(body);
  if (input.expectedSha256 !== undefined && (!SHA256.test(input.expectedSha256) || input.expectedSha256 !== hash)) {
    throw new Error("OBJECT_CHECKSUM_MISMATCH");
  }
  if (body.byteLength > 256 * 1024 * 1024) throw new Error("OBJECT_TOO_LARGE");
  for (const [name, value] of Object.entries(input.metadata ?? {})) {
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(name) || Buffer.byteLength(value, "utf8") > 1024) {
      throw new Error("INVALID_OBJECT_METADATA");
    }
  }
  return { key, body, hash };
}

interface LocalMetadata {
  contentType: string;
  cacheControl?: string;
  metadata: Record<string, string>;
  sha256: string;
  etag: string;
  size: number;
  updatedAt: string;
}

export class LocalObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    if (!root || root.includes("\0")) throw new Error("INVALID_OBJECT_ROOT");
    this.root = resolve(root);
  }

  private paths(keyValue: string): { data: string; meta: string } {
    const key = objectKey(keyValue);
    const data = resolve(this.root, ...key.split("/"));
    if (data !== this.root && !data.startsWith(`${this.root}${sep}`)) throw new Error("INVALID_OBJECT_KEY");
    return { data, meta: `${data}.forgestudio-meta.json` };
  }

  async put(input: PutObjectInput): Promise<ObjectHead> {
    const validated = validatePut(input);
    const paths = this.paths(validated.key);
    await mkdir(dirname(paths.data), { recursive: true });
    if (input.ifNoneMatch && await this.head(validated.key)) throw new Error("OBJECT_ALREADY_EXISTS");

    const updatedAt = new Date().toISOString();
    const metadata: LocalMetadata = {
      contentType: input.contentType,
      metadata: { ...(input.metadata ?? {}) },
      sha256: validated.hash,
      etag: `\"${validated.hash}\"`,
      size: validated.body.byteLength,
      updatedAt,
    };
    if (input.cacheControl !== undefined) metadata.cacheControl = input.cacheControl;

    const token = randomUUID();
    const temporaryData = `${paths.data}.${token}.tmp`;
    const temporaryMeta = `${paths.meta}.${token}.tmp`;
    await writeFile(temporaryData, validated.body, { flag: "wx", mode: 0o600 });
    await writeFile(temporaryMeta, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    await rename(temporaryData, paths.data);
    await rename(temporaryMeta, paths.meta);
    return this.toHead(validated.key, metadata);
  }

  async get(keyValue: string): Promise<StoredObject> {
    const key = objectKey(keyValue);
    const paths = this.paths(key);
    const [body, metadata] = await Promise.all([readFile(paths.data), this.readMetadata(paths.meta)]);
    const actual = sha256(body);
    if (actual !== metadata.sha256 || body.byteLength !== metadata.size) throw new Error("OBJECT_INTEGRITY_FAILURE");
    return { ...this.toHead(key, metadata), body };
  }

  async head(keyValue: string): Promise<ObjectHead | null> {
    const key = objectKey(keyValue);
    const paths = this.paths(key);
    try {
      const [metadata, info] = await Promise.all([this.readMetadata(paths.meta), stat(paths.data)]);
      if (!info.isFile() || info.size !== metadata.size) throw new Error("OBJECT_INTEGRITY_FAILURE");
      return this.toHead(key, metadata);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(keyValue: string): Promise<void> {
    const paths = this.paths(keyValue);
    await Promise.all([
      unlink(paths.data).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }),
      unlink(paths.meta).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }),
    ]);
  }

  async copy(sourceKey: string, destination: Omit<PutObjectInput, "body">): Promise<ObjectHead> {
    const source = await this.get(sourceKey);
    return this.put({ ...destination, body: source.body });
  }

  private async readMetadata(path: string): Promise<LocalMetadata> {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("OBJECT_METADATA_INVALID");
    const value = parsed as Partial<LocalMetadata>;
    if (typeof value.contentType !== "string" || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)
      || typeof value.etag !== "string" || typeof value.size !== "number" || typeof value.updatedAt !== "string"
      || !value.metadata || typeof value.metadata !== "object") {
      throw new Error("OBJECT_METADATA_INVALID");
    }
    return value as LocalMetadata;
  }

  private toHead(key: string, metadata: LocalMetadata): ObjectHead {
    const head: ObjectHead = {
      key,
      contentType: metadata.contentType,
      metadata: { ...metadata.metadata },
      sha256: metadata.sha256,
      etag: metadata.etag,
      size: metadata.size,
      updatedAt: metadata.updatedAt,
    };
    if (metadata.cacheControl !== undefined) head.cacheControl = metadata.cacheControl;
    return head;
  }
}

export interface S3ObjectStoreConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
  requestTimeoutMs?: number;
}

function encodePath(value: string): string {
  return value.split("/").map((part) => encodeURIComponent(part).replace(/%7E/g, "~")).join("/");
}

function awsDate(date: Date): { amz: string; day: string } {
  const amz = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz, day: amz.slice(0, 8) };
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signingKey(secret: string, day: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "s3"), "aws4_request");
}

function canonicalQuery(entries: ReadonlyArray<readonly [string, string]>): string {
  return [...entries]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function metadataFromHeaders(key: string, headers: Headers): ObjectHead {
  const contentLength = Number(headers.get("content-length"));
  const hash = headers.get("x-amz-meta-sha256") ?? headers.get("x-amz-checksum-sha256") ?? "";
  if (!Number.isSafeInteger(contentLength) || contentLength < 0 || !SHA256.test(hash)) throw new Error("OBJECT_METADATA_INVALID");
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith("x-amz-meta-") && name !== "x-amz-meta-sha256") metadata[name.slice(11)] = value;
  });
  const head: ObjectHead = {
    key,
    contentType: headers.get("content-type") ?? "application/octet-stream",
    metadata,
    sha256: hash,
    etag: headers.get("etag") ?? `\"${hash}\"`,
    size: contentLength,
    updatedAt: headers.get("last-modified") ?? new Date(0).toISOString(),
  };
  const cacheControl = headers.get("cache-control");
  if (cacheControl !== null) head.cacheControl = cacheControl;
  return head;
}

export class S3ObjectStore implements ObjectStore {
  private readonly config: Required<Omit<S3ObjectStoreConfig, "sessionToken">> & Pick<S3ObjectStoreConfig, "sessionToken">;
  private readonly endpoint: URL;

  constructor(config: S3ObjectStoreConfig) {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
      throw new Error("OBJECT_STORE_HTTPS_REQUIRED");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !/^[a-z0-9-]{3,32}$/.test(config.region)) {
      throw new Error("INVALID_OBJECT_STORE_CONFIG");
    }
    this.endpoint = endpoint;
    this.config = {
      ...config,
      forcePathStyle: config.forcePathStyle ?? true,
      requestTimeoutMs: config.requestTimeoutMs ?? 15_000,
    };
  }

  async put(input: PutObjectInput): Promise<ObjectHead> {
    const validated = validatePut(input);
    const headers = new Headers({
      "content-type": input.contentType,
      "x-amz-meta-sha256": validated.hash,
    });
    if (input.cacheControl !== undefined) headers.set("cache-control", input.cacheControl);
    if (input.ifNoneMatch) headers.set("if-none-match", "*");
    for (const [name, value] of Object.entries(input.metadata ?? {})) headers.set(`x-amz-meta-${name.toLowerCase()}`, value);
    const response = await this.request("PUT", validated.key, validated.body, headers, validated.hash);
    if (response.status === 412) throw new Error("OBJECT_ALREADY_EXISTS");
    if (!response.ok) throw new Error(`OBJECT_PUT_FAILED:${response.status}`);
    return {
      key: validated.key,
      contentType: input.contentType,
      ...(input.cacheControl === undefined ? {} : { cacheControl: input.cacheControl }),
      metadata: { ...(input.metadata ?? {}) },
      sha256: validated.hash,
      etag: response.headers.get("etag") ?? `\"${validated.hash}\"`,
      size: validated.body.byteLength,
      updatedAt: new Date().toISOString(),
    };
  }

  async get(keyValue: string): Promise<StoredObject> {
    const key = objectKey(keyValue);
    const response = await this.request("GET", key, undefined, new Headers(), sha256(""));
    if (response.status === 404) throw new Error("OBJECT_NOT_FOUND");
    if (!response.ok) throw new Error(`OBJECT_GET_FAILED:${response.status}`);
    const body = new Uint8Array(await response.arrayBuffer());
    const head = metadataFromHeaders(key, response.headers);
    if (body.byteLength !== head.size || sha256(body) !== head.sha256) throw new Error("OBJECT_INTEGRITY_FAILURE");
    return { ...head, body };
  }

  async head(keyValue: string): Promise<ObjectHead | null> {
    const key = objectKey(keyValue);
    const response = await this.request("HEAD", key, undefined, new Headers(), sha256(""));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OBJECT_HEAD_FAILED:${response.status}`);
    return metadataFromHeaders(key, response.headers);
  }

  async delete(keyValue: string): Promise<void> {
    const key = objectKey(keyValue);
    const response = await this.request("DELETE", key, undefined, new Headers(), sha256(""));
    if (!response.ok && response.status !== 404) throw new Error(`OBJECT_DELETE_FAILED:${response.status}`);
  }

  async copy(sourceKey: string, destination: Omit<PutObjectInput, "body">): Promise<ObjectHead> {
    const source = await this.get(sourceKey);
    return this.put({ ...destination, body: source.body });
  }

  async presignPut(input: Omit<PutObjectInput, "body">, expiresSeconds: number): Promise<string> {
    return this.presign("PUT", input.key, expiresSeconds, input.contentType);
  }

  async presignGet(key: string, expiresSeconds: number): Promise<string> {
    return this.presign("GET", key, expiresSeconds);
  }

  private url(key: string): URL {
    const encoded = encodePath(objectKey(key));
    const url = new URL(this.endpoint.toString());
    if (this.config.forcePathStyle) url.pathname = `${url.pathname.replace(/\/$/, "")}/${this.config.bucket}/${encoded}`;
    else {
      url.hostname = `${this.config.bucket}.${url.hostname}`;
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${encoded}`;
    }
    return url;
  }

  private async request(method: string, key: string, body: Uint8Array | undefined, headers: Headers, payloadHash: string): Promise<Response> {
    const url = this.url(key);
    const now = new Date();
    const stamp = awsDate(now);
    headers.set("host", url.host);
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", stamp.amz);
    if (this.config.sessionToken !== undefined) headers.set("x-amz-security-token", this.config.sessionToken);
    const headerPairs: Array<readonly [string, string]> = [];
    headers.forEach((value, name) => {
      headerPairs.push([name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const);
    });
    const normalized = headerPairs.sort(([a], [b]) => a.localeCompare(b));
    const signedHeaders = normalized.map(([name]) => name).join(";");
    const canonicalHeaders = normalized.map(([name, value]) => `${name}:${value}\n`).join("");
    const canonical = [method, url.pathname, url.searchParams.toString(), canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${stamp.day}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", stamp.amz, scope, sha256(canonical)].join("\n");
    const signature = createHmac("sha256", signingKey(this.config.secretAccessKey, stamp.day, this.config.region)).update(stringToSign).digest("hex");
    headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const init: RequestInit = { method, headers, redirect: "error", signal: controller.signal };
      if (body !== undefined) init.body = body as BodyInit;
      return await fetch(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  private async presign(method: "GET" | "PUT", key: string, expiresSeconds: number, contentType?: string): Promise<string> {
    if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 30 || expiresSeconds > 3600) throw new Error("INVALID_PRESIGN_EXPIRY");
    const url = this.url(key);
    const stamp = awsDate(new Date());
    const scope = `${stamp.day}/${this.config.region}/s3/aws4_request`;
    const headers: Array<readonly [string, string]> = [["host", url.host]];
    if (contentType !== undefined) headers.push(["content-type", contentType]);
    const normalized = headers.map(([name, value]) => [name.toLowerCase(), value.trim()] as const).sort(([a], [b]) => a.localeCompare(b));
    const signedHeaders = normalized.map(([name]) => name).join(";");
    const query: Array<readonly [string, string]> = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${this.config.accessKeyId}/${scope}`],
      ["X-Amz-Date", stamp.amz],
      ["X-Amz-Expires", String(expiresSeconds)],
      ["X-Amz-SignedHeaders", signedHeaders],
    ];
    if (this.config.sessionToken !== undefined) query.push(["X-Amz-Security-Token", this.config.sessionToken]);
    const canonical = [
      method,
      url.pathname,
      canonicalQuery(query),
      normalized.map(([name, value]) => `${name}:${value}\n`).join(""),
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", stamp.amz, scope, sha256(canonical)].join("\n");
    const signature = createHmac("sha256", signingKey(this.config.secretAccessKey, stamp.day, this.config.region)).update(stringToSign).digest("hex");
    query.push(["X-Amz-Signature", signature]);
    url.search = canonicalQuery(query);
    return url.toString();
  }
}

export function objectStoreFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ObjectStore {
  const driver = environment.OBJECT_STORE_DRIVER ?? "local";
  if (driver === "local") return new LocalObjectStore(environment.OBJECT_STORE_LOCAL_ROOT ?? "/tmp/forgestudio-objects");
  if (driver !== "s3") throw new Error("INVALID_OBJECT_STORE_DRIVER");
  const required = ["OBJECT_STORE_ENDPOINT", "OBJECT_STORE_BUCKET", "OBJECT_STORE_REGION", "OBJECT_STORE_ACCESS_KEY_ID", "OBJECT_STORE_SECRET_ACCESS_KEY"] as const;
  for (const name of required) if (!environment[name]) throw new Error(`MISSING_ENVIRONMENT:${name}`);
  return new S3ObjectStore({
    endpoint: environment.OBJECT_STORE_ENDPOINT!,
    bucket: environment.OBJECT_STORE_BUCKET!,
    region: environment.OBJECT_STORE_REGION!,
    accessKeyId: environment.OBJECT_STORE_ACCESS_KEY_ID!,
    secretAccessKey: environment.OBJECT_STORE_SECRET_ACCESS_KEY!,
    ...(environment.OBJECT_STORE_SESSION_TOKEN ? { sessionToken: environment.OBJECT_STORE_SESSION_TOKEN } : {}),
    forcePathStyle: environment.OBJECT_STORE_FORCE_PATH_STYLE !== "false",
    requestTimeoutMs: Number(environment.OBJECT_STORE_REQUEST_TIMEOUT_MS ?? 15_000),
  });
}
