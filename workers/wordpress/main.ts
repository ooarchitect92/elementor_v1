import { NodePostgresPool } from "../../packages/platform/node-postgres.ts";
import { connectJobWorker } from "../shared/rabbit-worker.ts";
import { WordPressSyncAdapter } from "./wordpress-sync-adapter.ts";

function log(level: "info" | "error", event: string, details: Record<string, unknown> = {}) {
  const body = JSON.stringify({
    level,
    event,
    service: "forgestudio-wordpress-sync-worker",
    at: new Date().toISOString(),
    ...details,
  });
  if (level === "error") console.error(body); else console.log(body);
}

async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function main() {
  const abort = new AbortController();
  const shutdown = () => abort.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const pool = new NodePostgresPool({
    ...process.env,
    SERVICE_NAME: process.env.SERVICE_NAME || "forgestudio-wordpress-sync-worker",
  });
  let worker: Awaited<ReturnType<typeof connectJobWorker>> | undefined;
  try {
    await pool.ping();
    worker = await connectJobWorker("wordpress.sync", new WordPressSyncAdapter(pool), pool, abort.signal, process.env);
    await worker.ping();
    log("info", "worker.started", { queue: worker.queue });
    await waitForAbort(abort.signal);
  } finally {
    if (worker) await worker.close();
    await pool.close();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    log("info", "worker.stopped");
  }
}

main().catch((error: unknown) => {
  log("error", "worker.fatal", { code: error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN" });
  process.exitCode = 1;
});
