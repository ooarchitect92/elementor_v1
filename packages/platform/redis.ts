import { uuid, canonicalJson } from '../events/index.ts';
export interface RedisPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: {EX: number}): Promise<unknown>;
  eval(script: string, options: {keys: string[]; arguments: string[]}): Promise<unknown>;
}
export function cacheKey(env: string, cell: string, tenantId: string, kind: string, id: string, version: number): string {
  for (const part of [env, cell, kind, id]) if (!/^[A-Za-z0-9_-]{1,80}$/.test(part)) throw new Error('UNSAFE_CACHE_KEY');
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('INVALID_CACHE_VERSION');
  return `fs:${env}:${cell}:{${uuid(tenantId)}}:${kind}:${id}:v${version}`;
}
export class TenantCache {
  private client: RedisPort;
  constructor(client: RedisPort) { this.client = client; }
  async get(key: string): Promise<unknown | null> {
    try { const value = await this.client.get(key); return value === null ? null : JSON.parse(value); } catch { return null; }
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) throw new Error('INVALID_CACHE_TTL');
    const body = canonicalJson(value);
    try { await this.client.set(key, body, {EX: ttlSeconds}); return true; } catch { return false; }
  }
}
// One key/slot; increment and initial expiry are atomic. Use redis-control, not evictable cache.
export const RATE_LIMIT_LUA = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}`;
export async function rateLimit(client: RedisPort, key: string, limit: number, windowMs: number): Promise<{allowed: boolean; retryAfterMs: number}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 100 || windowMs > 86400000) throw new Error('INVALID_RATE_LIMIT');
  try {
    const result = await client.eval(RATE_LIMIT_LUA, {keys: [key], arguments: [String(windowMs)]});
    if (!Array.isArray(result) || result.length !== 2 || !Number.isInteger(result[0]) || !Number.isInteger(result[1]) || result[0] < 1 || result[1] < 0) throw new Error('INVALID_LIMITER_RESPONSE');
    return {allowed: result[0] <= limit, retryAfterMs: result[0] > limit ? result[1] : 0};
  } catch { throw new Error('LIMITER_UNAVAILABLE'); }
}
