import type { Adapter } from "../../packages/adapter-sdk/index.ts";
import { parseTask, type JobType } from "../../packages/events/index.ts";
import {
  connectRabbitConsumer,
  type ConnectedRabbitConsumer,
} from "../../packages/platform/node-rabbitmq.ts";
import type { RuntimeEnvironment } from "../../packages/platform/runtime-config.ts";
import type { SqlPool } from "./postgres.ts";
import { PgJobStore, type PgStoreOptions } from "./pg-stores.ts";
import { executeDelivery } from "./worker.ts";

export interface ConnectedJobWorker {
  readonly queue: JobType;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connects one tested adapter to one RabbitMQ command queue. The caller owns
 * process supervision and must never register two adapters for the same queue
 * in one process.
 */
export async function connectJobWorker(
  queue: JobType,
  adapter: Adapter,
  pool: SqlPool,
  signal: AbortSignal,
  environment: RuntimeEnvironment = process.env,
  storeOptions: PgStoreOptions = {},
): Promise<ConnectedJobWorker> {
  if (!adapter.id || !/^[A-Za-z0-9._-]{1,100}$/.test(adapter.id)) {
    throw new Error("INVALID_ADAPTER_ID");
  }
  if (!["none", "idempotent", "non-idempotent"].includes(adapter.sideEffects)) {
    throw new Error("INVALID_ADAPTER_SIDE_EFFECTS");
  }

  const store = new PgJobStore(pool, storeOptions);
  const consumer: ConnectedRabbitConsumer = await connectRabbitConsumer(
    queue,
    async (delivery) => {
      try {
        if (parseTask(delivery.body).jobType !== queue) {
          delivery.deadLetter();
          return;
        }
      } catch {
        // executeDelivery owns malformed-contract dead-lettering.
      }
      await executeDelivery(store, delivery, adapter, signal);
    },
    environment,
  );

  return {
    queue,
    ping: () => consumer.ping(),
    close: () => consumer.close(),
  };
}
