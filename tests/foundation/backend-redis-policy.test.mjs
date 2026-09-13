import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  authSessionCacheKey,
  distributedRateLimitKey,
  sessionActivityKey,
  sessionCacheTtlSeconds,
} from "../../backend/src/platform/redis-runtime.ts";

test("Redis keys never expose raw rate-limit subjects", () => {
  const subject = "203.0.113.9:tenant-secret";
  const key = distributedRateLimitKey("public-form", subject);
  assert(!key.includes(subject));
  assert.match(key, /:[0-9a-f]{64}$/);
});

test("auth cache accepts only SHA-256 token hashes", () => {
  const hash = crypto.createHash("sha256").update("token").digest("hex");
  assert.match(authSessionCacheKey(hash), new RegExp(`${hash}$`));
  assert.throws(() => authSessionCacheKey("raw-token"), /INVALID_TOKEN_HASH/);
});

test("activity keys hide session identifiers", () => {
  const id = crypto.randomUUID();
  const key = sessionActivityKey(id);
  assert(!key.includes(id));
});

test("session cache TTL never exceeds expiry or configured safety bound", () => {
  const previous = process.env.SESSION_CACHE_TTL_SECONDS;
  process.env.SESSION_CACHE_TTL_SECONDS = "15";
  try {
    assert.equal(sessionCacheTtlSeconds(new Date(Date.now() + 60_000)), 15);
    assert(sessionCacheTtlSeconds(new Date(Date.now() + 2_500)) <= 2);
    assert.equal(sessionCacheTtlSeconds(new Date(Date.now() - 1_000)), 0);
  } finally {
    if (previous === undefined) delete process.env.SESSION_CACHE_TTL_SECONDS;
    else process.env.SESSION_CACHE_TTL_SECONDS = previous;
  }
});
