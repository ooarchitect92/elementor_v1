import test from "node:test";
import assert from "node:assert/strict";
import { executeDelivery } from "../../workers/shared/worker.ts";
import { relayBatch } from "../../workers/shared/outbox.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const TRACE = "33333333-3333-4333-8333-333333333333";
const TOKEN = "44444444-4444-4444-8444-444444444444";
const deadline = "2030-01-01T00:00:00Z";
const task = {
  schemaVersion: 1,
  jobId: JOB,
  tenantId: TENANT,
  jobType: "publish.build",
  deadline,
  traceId: TRACE,
};

function lease(overrides = {}) {
  return {
    tenantId: TENANT,
    jobId: JOB,
    token: TOKEN,
    payloadRef: "artifact:tenant/site/revision-1",
    idempotencyKey: "stable-worker-key",
    jobType: "publish.build",
    deadline,
    traceId: TRACE,
    attempt: 1,
    maxAttempts: 5,
    sideEffects: "idempotent",
    ...overrides,
  };
}

test("adapter side-effect mismatch fails durably before remote delivery", async () => {
  const order = [];
  let persisted;
  await executeDelivery(
    {
      claim: async () => lease({ sideEffects: "non-idempotent" }),
      complete: async (_lease, outcome) => {
        order.push("commit");
        persisted = outcome;
        return true;
      },
    },
    {
      body: task,
      ack: () => order.push("ack"),
      deadLetter: () => order.push("dead"),
    },
    {
      id: "publish-adapter",
      sideEffects: "idempotent",
      deliver: async () => {
        order.push("remote");
        return { status: "DELIVERED", receipt: "must-not-run" };
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(order, ["commit", "ack"]);
  assert.deepEqual(persisted, {
    status: "FAILED_PERMANENTLY",
    code: "ADAPTER_SIDE_EFFECT_POLICY_MISMATCH",
  });
});

test("lease identity mismatch is never acknowledged", async () => {
  let acknowledged = false;
  await assert.rejects(
    executeDelivery(
      {
        claim: async () => lease({ traceId: "55555555-5555-4555-8555-555555555555" }),
        complete: async () => true,
      },
      {
        body: task,
        ack: () => { acknowledged = true; },
        deadLetter: () => undefined,
      },
      {
        id: "publish-adapter",
        sideEffects: "idempotent",
        deliver: async () => ({ status: "DELIVERED", receipt: "never" }),
      },
      new AbortController().signal,
    ),
    /LEASE_SCOPE_MISMATCH/,
  );
  assert.equal(acknowledged, false);
});

test("outbox refuses to hide an unpersisted retry decision", async () => {
  const claim = {
    tenantId: TENANT,
    eventId: TRACE,
    destination: "rabbitmq",
    leaseToken: TOKEN,
    leaseExpiresAt: deadline,
    attempt: 0,
    body: task,
  };
  await assert.rejects(
    relayBatch(
      {
        claim: async () => [claim],
        markSent: async () => true,
        retry: async () => false,
      },
      "rabbitmq",
      { publish: async () => { throw new Error("broker down"); } },
    ),
    /OUTBOX_RETRY_NOT_PERSISTED/,
  );
});
