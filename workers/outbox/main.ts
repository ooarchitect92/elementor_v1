import { connectKafkaPublisher } from "../../packages/platform/node-kafka.ts";
import { NodePostgresPool } from "../../packages/platform/node-postgres.ts";
import { connectRabbitPublisher } from "../../packages/platform/node-rabbitmq.ts";
import {
  integerEnvironment,
  workerTenantIds,
} from "../../packages/platform/runtime-config.ts";
import type { Destination } from "../../packages/events/index.ts";
import { relayBatch, type ConfirmedPublisher } from "../shared/outbox.ts";
import { PgJobStore, PgOutboxStore } from "../shared/pg-stores.ts";

interface CloseablePublisher {
  publisher: ConfirmedPublisher;
  ping(): Promise<void>;
  close(): Promise<void>;
}

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}): void {
  const body = JSON.stringify({
    level,
    event,
    service: "forgestudio-outbox",
    at: new Date().toISOString(),
    ...details,
  });
  if (level === "error") console.error(body);
  else console.log(body);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function destinationLoop(
  destination: Destination,
  tenants: readonly string[],
  pool: NodePostgresPool,
  factory: () => Promise<CloseablePublisher>,
  signal: AbortSignal,
): Promise<void> {
  const batchSize = integerEnvironment(process.env, "OUTBOX_BATCH_SIZE", 32, 1, 128);
  const idleMs = integerEnvironment(process.env, "OUTBOX_IDLE_MS", 250, 25, 30_000);
  let failures = 0;

  while (!signal.aborted) {
    let client: CloseablePublisher | undefined;
    try {
      client = await factory();
      await client.ping();
      log("info", "destination.connected", { destination });

      while (!signal.aborted) {
        let activity = 0;
        for (const tenantId of tenants) {
          const store = new PgOutboxStore(pool, tenantId);
          const result = await relayBatch(
            store,
            destination,
            client.publisher,
            batchSize,
          );
          activity += result.sent + result.deferred;
          if (result.sent || result.deferred) {
            log("info", "relay.batch", { destination, tenantId, ...result });
          }
        }
        failures = 0;
        if (activity === 0) await sleep(idleMs, signal);
      }
    } catch (error) {
      failures += 1;
      log("error", "destination.failed", {
        destination,
        failures,
        code: error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN",
      });
    } finally {
      if (client) {
        try { await client.close(); } catch { /* already disconnected */ }
      }
    }

    if (!signal.aborted) {
      const backoff = Math.min(30_000, 250 * 2 ** Math.min(failures, 7));
      await sleep(backoff, signal);
    }
  }
}

async function recoveryLoop(
  tenants: readonly string[],
  store: PgJobStore,
  signal: AbortSignal,
): Promise<void> {
  const intervalMs = integerEnvironment(
    process.env,
    "LEASE_RECOVERY_INTERVAL_MS",
    10_000,
    1_000,
    300_000,
  );
  while (!signal.aborted) {
    try {
      for (const tenantId of tenants) {
        const result = await store.recoverExpiredLeases(tenantId);
        if (result.retried || result.failed || result.unknown) {
          log("info", "lease.recovery", { tenantId, ...result });
        }
      }
    } catch (error) {
      log("error", "lease.recovery.failed", {
        code: error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN",
      });
    }
    await sleep(intervalMs, signal);
  }
}

async function main(): Promise<void> {
  const tenants = workerTenantIds(process.env);
  const abort = new AbortController();
  const shutdown = () => abort.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const pool = new NodePostgresPool(process.env);
  await pool.ping();
  const jobStore = new PgJobStore(pool);

  log("info", "worker.started", { tenantCount: tenants.length });
  try {
    await Promise.all([
      destinationLoop(
        "rabbitmq",
        tenants,
        pool,
        () => connectRabbitPublisher(process.env),
        abort.signal,
      ),
      destinationLoop(
        "kafka",
        tenants,
        pool,
        () => connectKafkaPublisher(process.env),
        abort.signal,
      ),
      recoveryLoop(tenants, jobStore, abort.signal),
    ]);
  } finally {
    await pool.close();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    log("info", "worker.stopped");
  }
}

main().catch((error: unknown) => {
  log("error", "worker.fatal", {
    code: error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN",
  });
  process.exitCode = 1;
});
