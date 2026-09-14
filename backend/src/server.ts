import "dotenv/config";
import app from "./app.js";
import { prisma } from "./config/prisma.js";
import { closeRedisRuntime } from "./platform/redis-runtime.js";
import { startScheduler } from "./services/scheduleWorker.js";

const port = Number(process.env.PORT || 5000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const server = app.listen(port, () => {
  console.log(JSON.stringify({ event: "server.started", port }));
});
const stopScheduler = process.env.ENABLE_LEGACY_SCHEDULER === "true" && process.env.NODE_ENV !== "production"
  ? startScheduler()
  : () => {};
let stopping = false;

function shutdown() {
  if (stopping) return;
  stopping = true;
  stopScheduler();
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  server.close(() => {
    void Promise.allSettled([prisma.$disconnect(), closeRedisRuntime()]).then((results) => {
      if (results.some((result) => result.status === "rejected")) process.exitCode = 1;
      clearTimeout(deadline);
    });
  });
  server.closeIdleConnections();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
