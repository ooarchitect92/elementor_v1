import { createHash } from "node:crypto";
import { createClient } from "redis";

type RedisKind = "cache" | "control";
type RuntimeRedisClient = ReturnType<typeof createClient>;

export interface CachedAuthSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: null;
  lastUsedAt: Date | null;
  createdAt: Date;
  user: {
    id: string;
    fullName: string | null;
    email: string | null;
    phone: string | null;
    verificationMethod: string | null;
    emailVerified: boolean;
    phoneVerified: boolean;
    status: string;
    role: string;
    lastLoginAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
}

interface CachedAuthEnvelope {
  version: 1;
  session: {
    id: string;
    userId: string;
    expiresAt: string;
    lastUsedAt: string | null;
    createdAt: string;
  };
  user: {
    id: string;
    fullName: string | null;
    email: string | null;
    phone: string | null;
    verificationMethod: string | null;
    emailVerified: boolean;
    phoneVerified: boolean;
    status: string;
    role: string;
    lastLoginAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

const clients: Record<RedisKind, Promise<RuntimeRedisClient> | null> = {
  cache: null,
  control: null,
};
const unavailableUntil: Record<RedisKind, number> = { cache: 0, control: 0 };
const REDIS_FAILURE_COOLDOWN_MS = 5_000;
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9:_-]{1,160}$/;

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function environmentName(): string {
  const value = String(process.env.NODE_ENV || "development").toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(value) ? value : "development";
}

function redisConnectionUrl(kind: RedisKind): string | null {
  const explicit = process.env[kind === "cache" ? "REDIS_CACHE_URL" : "REDIS_CONTROL_URL"]?.trim();
  if (explicit) {
    const parsed = new URL(explicit);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error(`REDIS_${kind.toUpperCase()}_URL_INVALID`);
    }
    return parsed.toString();
  }

  const password = process.env.REDIS_PASSWORD;
  if (!password) return null;
  const hostName = kind === "cache" ? "REDIS_CACHE_HOST" : "REDIS_CONTROL_HOST";
  const portName = kind === "cache" ? "REDIS_CACHE_PORT" : "REDIS_CONTROL_PORT";
  const host = String(process.env[hostName] || "127.0.0.1").trim();
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error(`${hostName}_INVALID`);
  const port = integerEnv(portName, kind === "cache" ? 6379 : 6380, 1, 65535);
  const url = new URL(`redis://${host}:${port}`);
  url.password = password;
  return url.toString();
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 100).replace(/[^A-Za-z0-9:_-]/g, "_");
  return "UNKNOWN";
}

async function connect(kind: RedisKind): Promise<RuntimeRedisClient> {
  const url = redisConnectionUrl(kind);
  if (!url) throw new Error(`REDIS_${kind.toUpperCase()}_NOT_CONFIGURED`);
  const connectTimeout = integerEnv("REDIS_CONNECT_TIMEOUT_MS", 1_500, 100, 10_000);
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout,
      reconnectStrategy: (retries) => (retries >= 1 ? false : 100),
    },
  });
  let lastErrorLogAt = 0;
  client.on("error", (error) => {
    const now = Date.now();
    if (now - lastErrorLogAt >= REDIS_FAILURE_COOLDOWN_MS) {
      lastErrorLogAt = now;
      console.error(JSON.stringify({ event: "redis.error", kind, code: safeErrorCode(error) }));
    }
  });
  await client.connect();
  return client;
}

async function getClient(kind: RedisKind): Promise<RuntimeRedisClient | null> {
  if (Date.now() < unavailableUntil[kind]) return null;
  if (!clients[kind]) clients[kind] = connect(kind);
  const pending = clients[kind];
  try {
    return await pending;
  } catch (error) {
    if (clients[kind] === pending) clients[kind] = null;
    unavailableUntil[kind] = Date.now() + REDIS_FAILURE_COOLDOWN_MS;
    console.error(JSON.stringify({ event: "redis.unavailable", kind, code: safeErrorCode(error) }));
    return null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function authSessionCacheKey(tokenHash: string): string {
  if (!TOKEN_HASH.test(tokenHash)) throw new Error("INVALID_TOKEN_HASH");
  return `fs:${environmentName()}:auth:session:${tokenHash}`;
}

export function distributedRateLimitKey(scope: string, subject: string): string {
  if (!IDENTIFIER.test(scope)) throw new Error("INVALID_RATE_LIMIT_SCOPE");
  return `fs:${environmentName()}:control:limit:${scope}:${sha256(subject)}`;
}

export function sessionActivityKey(sessionId: string): string {
  if (!IDENTIFIER.test(sessionId)) throw new Error("INVALID_SESSION_ID");
  return `fs:${environmentName()}:control:session-activity:${sha256(sessionId)}`;
}

export function sessionCacheTtlSeconds(expiresAt: Date, now = Date.now()): number {
  const configured = integerEnv("SESSION_CACHE_TTL_SECONDS", 15, 1, 60);
  const remaining = Math.floor((expiresAt.getTime() - now) / 1_000);
  return Math.max(0, Math.min(configured, remaining));
}

function dateOrNull(value: unknown): Date | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("INVALID_CACHE_DATE");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_CACHE_DATE");
  return date;
}

function requiredDate(value: unknown): Date {
  const parsed = dateOrNull(value);
  if (!parsed) throw new Error("INVALID_CACHE_DATE");
  return parsed;
}

function normalizeEnvelope(value: any, tokenHash: string): CachedAuthSession {
  if (!value || value.version !== 1 || !value.session || !value.user) throw new Error("INVALID_CACHE_ENVELOPE");
  const session = value.session;
  const user = value.user;
  if (typeof session.id !== "string" || typeof session.userId !== "string" || typeof user.id !== "string") {
    throw new Error("INVALID_CACHE_ENVELOPE");
  }
  const expiresAt = requiredDate(session.expiresAt);
  if (expiresAt.getTime() <= Date.now()) throw new Error("EXPIRED_CACHE_ENVELOPE");
  return {
    id: session.id,
    userId: session.userId,
    tokenHash,
    expiresAt,
    revokedAt: null,
    lastUsedAt: dateOrNull(session.lastUsedAt),
    createdAt: requiredDate(session.createdAt),
    user: {
      id: user.id,
      fullName: typeof user.fullName === "string" ? user.fullName : null,
      email: typeof user.email === "string" ? user.email : null,
      phone: typeof user.phone === "string" ? user.phone : null,
      verificationMethod: typeof user.verificationMethod === "string" ? user.verificationMethod : null,
      emailVerified: user.emailVerified === true,
      phoneVerified: user.phoneVerified === true,
      status: String(user.status || ""),
      role: String(user.role || ""),
      lastLoginAt: dateOrNull(user.lastLoginAt),
      createdAt: requiredDate(user.createdAt),
      updatedAt: requiredDate(user.updatedAt),
    },
  };
}

function toEnvelope(session: any): CachedAuthEnvelope {
  if (!session?.id || !session?.userId || !session?.expiresAt || !session?.createdAt || !session?.user?.id) {
    throw new Error("INVALID_SESSION_CACHE_INPUT");
  }
  return {
    version: 1,
    session: {
      id: String(session.id),
      userId: String(session.userId),
      expiresAt: new Date(session.expiresAt).toISOString(),
      lastUsedAt: session.lastUsedAt ? new Date(session.lastUsedAt).toISOString() : null,
      createdAt: new Date(session.createdAt).toISOString(),
    },
    user: {
      id: String(session.user.id),
      fullName: typeof session.user.fullName === "string" ? session.user.fullName : null,
      email: typeof session.user.email === "string" ? session.user.email : null,
      phone: typeof session.user.phone === "string" ? session.user.phone : null,
      verificationMethod: session.user.verificationMethod ? String(session.user.verificationMethod) : null,
      emailVerified: session.user.emailVerified === true,
      phoneVerified: session.user.phoneVerified === true,
      status: String(session.user.status || ""),
      role: String(session.user.role || ""),
      lastLoginAt: session.user.lastLoginAt ? new Date(session.user.lastLoginAt).toISOString() : null,
      createdAt: new Date(session.user.createdAt).toISOString(),
      updatedAt: new Date(session.user.updatedAt).toISOString(),
    },
  };
}

export async function getCachedAuthSession(tokenHash: string): Promise<CachedAuthSession | null> {
  const client = await getClient("cache");
  if (!client) return null;
  const key = authSessionCacheKey(tokenHash);
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    if (raw.length > 16_384) throw new Error("CACHE_VALUE_TOO_LARGE");
    return normalizeEnvelope(JSON.parse(raw), tokenHash);
  } catch {
    try { await client.del(key); } catch { /* best-effort corrupt entry removal */ }
    return null;
  }
}

export async function cacheAuthSession(tokenHash: string, session: any): Promise<boolean> {
  if (session?.revokedAt || session?.user?.status !== "ACTIVE") return false;
  const expiresAt = new Date(session.expiresAt);
  const ttl = sessionCacheTtlSeconds(expiresAt);
  if (ttl < 1) return false;
  const client = await getClient("cache");
  if (!client) return false;
  try {
    const body = JSON.stringify(toEnvelope(session));
    if (body.length > 16_384) return false;
    await client.set(authSessionCacheKey(tokenHash), body, { EX: ttl });
    return true;
  } catch {
    return false;
  }
}

export async function invalidateAuthSession(tokenHash: string): Promise<boolean> {
  const client = await getClient("cache");
  if (!client) return false;
  try {
    await client.del(authSessionCacheKey(tokenHash));
    return true;
  } catch {
    return false;
  }
}

export async function invalidateAuthSessions(tokenHashes: string[]): Promise<boolean> {
  const keys = [...new Set(tokenHashes.filter((value) => TOKEN_HASH.test(value)).map(authSessionCacheKey))];
  if (keys.length === 0) return true;
  const client = await getClient("cache");
  if (!client) return false;
  try {
    await client.del(keys);
    return true;
  } catch {
    return false;
  }
}

export async function claimSessionActivity(sessionId: string): Promise<boolean | null> {
  const client = await getClient("control");
  if (!client) return null;
  const interval = integerEnv("SESSION_ACTIVITY_INTERVAL_SECONDS", 300, 60, 3_600);
  try {
    const result = await client.set(sessionActivityKey(sessionId), "1", { EX: interval, NX: true });
    return result === "OK";
  } catch {
    return null;
  }
}

const FIXED_WINDOW_LUA = `local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {current, redis.call('PTTL', KEYS[1])}`;

export async function consumeFixedWindow(
  scope: string,
  subject: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new Error("INVALID_RATE_LIMIT");
  if (!Number.isSafeInteger(windowMs) || windowMs < 100 || windowMs > 86_400_000) throw new Error("INVALID_RATE_WINDOW");
  const client = await getClient("control");
  if (!client) throw new Error("REDIS_CONTROL_UNAVAILABLE");
  const result = await client.eval(FIXED_WINDOW_LUA, {
    keys: [distributedRateLimitKey(scope, subject)],
    arguments: [String(windowMs)],
  });
  if (!Array.isArray(result) || result.length !== 2) throw new Error("INVALID_RATE_LIMIT_RESPONSE");
  const current = Number(result[0]);
  const ttl = Number(result[1]);
  if (!Number.isSafeInteger(current) || current < 1 || !Number.isSafeInteger(ttl) || ttl < 0) {
    throw new Error("INVALID_RATE_LIMIT_RESPONSE");
  }
  return {
    allowed: current <= limit,
    remaining: Math.max(0, limit - current),
    retryAfterMs: current > limit ? ttl : 0,
  };
}

export async function closeRedisRuntime(): Promise<void> {
  const pending = [clients.cache, clients.control].filter((value): value is Promise<RuntimeRedisClient> => Boolean(value));
  clients.cache = null;
  clients.control = null;
  await Promise.allSettled(pending.map(async (entry) => {
    try {
      const client = await entry;
      if (client.isOpen) client.destroy();
    } catch { /* already unavailable */ }
  }));
}
