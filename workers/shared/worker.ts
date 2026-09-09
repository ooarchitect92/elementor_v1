import { parseTask, type JobType } from "../../packages/events/index.ts";
import type { TaskEnvelope } from "../../packages/events/index.ts";
import { outcomeFromException } from "../../packages/adapter-sdk/index.ts";
import type { Adapter, DeliveryOutcome } from "../../packages/adapter-sdk/index.ts";

export interface JobLease {
  tenantId: string;
  jobId: string;
  token: string;
  payloadRef: string;
  idempotencyKey: string;
  jobType: JobType;
  deadline: string;
  traceId: string;
  attempt: number;
  maxAttempts: number;
  sideEffects: Adapter["sideEffects"];
}

export interface JobStore {
  /** Atomically verifies due time, deadline and state, then issues a new fencing token. */
  claim(task: TaskEnvelope): Promise<JobLease | null>;
  /** Persists outcome + next due time + retry outbox atomically, fenced by token. */
  complete(lease: JobLease, outcome: DeliveryOutcome): Promise<boolean>;
}

export interface Delivery {
  body: unknown;
  ack(): void;
  deadLetter(): void;
}

/** No handlers are registered automatically. Domain owners must opt in tested adapters. */
export async function executeDelivery(
  store: JobStore,
  delivery: Delivery,
  adapter: Adapter,
  signal: AbortSignal,
): Promise<void> {
  let task: TaskEnvelope;
  try {
    task = parseTask(delivery.body);
  } catch {
    delivery.deadLetter();
    return;
  }

  const lease = await store.claim(task);
  // A missing lease means the durable record is already terminal, not due, or owned by
  // another worker. ACK is safe because any future retry has its own outbox delivery.
  if (!lease) {
    delivery.ack();
    return;
  }
  if (
    lease.tenantId !== task.tenantId ||
    lease.jobId !== task.jobId ||
    (lease.jobType !== undefined && lease.jobType !== task.jobType) ||
    (lease.traceId !== undefined && lease.traceId !== task.traceId) ||
    (lease.deadline !== undefined && Date.parse(lease.deadline) !== Date.parse(task.deadline))
  ) {
    throw new Error("LEASE_SCOPE_MISMATCH");
  }

  if (lease.sideEffects !== undefined && lease.sideEffects !== adapter.sideEffects) {
    const recorded = await store.complete(lease, {
      status: "FAILED_PERMANENTLY",
      code: "ADAPTER_SIDE_EFFECT_POLICY_MISMATCH",
    });
    if (!recorded) throw new Error("LEASE_LOST");
    delivery.ack();
    return;
  }

  let result: DeliveryOutcome;
  try {
    if (signal.aborted) {
      result = { status: "RETRYABLE", code: "CANCELLED_BEFORE_DELIVERY" };
    } else {
      result = await adapter.deliver(
        {
          tenantId: lease.tenantId,
          jobId: lease.jobId,
          idempotencyKey: lease.idempotencyKey,
          signal,
        },
        lease.payloadRef,
      );
    }
  } catch {
    result = outcomeFromException(adapter.sideEffects);
  }

  if (!await store.complete(lease, result)) throw new Error("LEASE_LOST");
  delivery.ack(); // Never ACK before the durable outcome transaction commits.
}
