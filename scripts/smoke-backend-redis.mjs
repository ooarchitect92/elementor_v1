import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  cacheAuthSession,
  claimSessionActivity,
  closeRedisRuntime,
  consumeFixedWindow,
  getCachedAuthSession,
  invalidateAuthSession,
} from "../backend/src/platform/redis-runtime.ts";

const tokenHash = crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex");
const sessionId = crypto.randomUUID();
const now = new Date();
const session = {
  id: sessionId,
  userId: crypto.randomUUID(),
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  lastUsedAt: now,
  createdAt: now,
  user: {
    id: crypto.randomUUID(),
    fullName: "Redis Smoke",
    email: "redis-smoke@example.test",
    phone: null,
    verificationMethod: "EMAIL",
    emailVerified: true,
    phoneVerified: false,
    status: "ACTIVE",
    role: "USER",
    lastLoginAt: now,
    createdAt: now,
    updatedAt: now,
  },
};

try {
  assert.equal(await cacheAuthSession(tokenHash, session), true);
  const cached = await getCachedAuthSession(tokenHash);
  assert.equal(cached?.id, sessionId);
  assert.equal(cached?.user.email, session.user.email);
  assert(cached?.expiresAt instanceof Date);
  assert.equal(await invalidateAuthSession(tokenHash), true);
  assert.equal(await getCachedAuthSession(tokenHash), null);

  assert.equal(await claimSessionActivity(sessionId), true);
  assert.equal(await claimSessionActivity(sessionId), false);

  const subject = crypto.randomUUID();
  assert.equal((await consumeFixedWindow("redis-smoke", subject, 2, 10_000)).allowed, true);
  assert.equal((await consumeFixedWindow("redis-smoke", subject, 2, 10_000)).allowed, true);
  const denied = await consumeFixedWindow("redis-smoke", subject, 2, 10_000);
  assert.equal(denied.allowed, false);
  assert(denied.retryAfterMs > 0);
  console.log("PASS: backend Redis auth cache, invalidation, global activity claim and distributed limiter");
} finally {
  await closeRedisRuntime();
}
