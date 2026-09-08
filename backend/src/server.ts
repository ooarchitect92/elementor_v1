import "dotenv/config";
import app from "./app.js";
import { prisma } from "./config/prisma.js";
import { startScheduler } from "./services/scheduleWorker.js";
const port = Number(process.env.PORT || 5000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const server = app.listen(port, () => {
  console.log(JSON.stringify({event:'server.started', port}));
});
// This legacy poller is not a durable worker. Enable only explicitly in development.
const stopScheduler = process.env.ENABLE_LEGACY_SCHEDULER === 'true' && process.env.NODE_ENV !== 'production' ? startScheduler() : () => {};
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  stopScheduler();
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  server.close(() => {
    void prisma.$disconnect().then(() => {clearTimeout(deadline);}, () => {process.exitCode = 1;});
  });
  server.closeIdleConnections();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
