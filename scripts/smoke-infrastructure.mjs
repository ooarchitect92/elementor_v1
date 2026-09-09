import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function run(args, input) {
  const result = spawnSync("docker", ["compose", ...args], {
    input,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Infrastructure check failed: ${args[0]} ${args[1]}\n${result.stderr || result.error || ""}`,
    );
  }
  console.log(result.stdout.trim());
  return result.stdout;
}

run(
  [
    "exec",
    "-T",
    "postgres",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    process.env.POSTGRES_USER,
    "-d",
    process.env.POSTGRES_DB,
  ],
  readFileSync(new URL("../tests/integration/platform.sql", import.meta.url), "utf8"),
);

for (const service of ["redis-cache", "redis-control"]) {
  run(["exec", "-T", service, "sh", "-c", 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping']);
}
run(["exec", "-T", "rabbitmq", "rabbitmq-diagnostics", "-q", "check_running"]);

const auth = Buffer.from(
  `${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}`,
).toString("base64");
const response = await fetch(
  `http://127.0.0.1:${process.env.RABBITMQ_MANAGEMENT_PORT || "15672"}/api/queues/%2F`,
  {
    headers: { authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(10_000),
  },
);
if (!response.ok) throw new Error(`Queue inspection failed: HTTP ${response.status}`);
const queues = await response.json();
for (const name of [
  "publish.build",
  "wordpress.sync",
  "media.process",
  "integration.deliver",
  "maintenance.reconcile",
]) {
  const queue = queues.find((candidate) => candidate.name === name);
  if (
    !queue ||
    queue.type !== "quorum" ||
    queue.arguments["x-dead-letter-strategy"] !== "at-least-once"
  ) {
    throw new Error(`Queue policy missing: ${name}`);
  }
}

if (process.argv.includes("--kafka")) {
  const topics = run([
    "--profile",
    "analytics",
    "exec",
    "-T",
    "kafka",
    "/opt/kafka/bin/kafka-topics.sh",
    "--bootstrap-server",
    "kafka:9092",
    "--list",
  ]);
  for (const topic of [
    "site.lifecycle.v1",
    "content.changed.v1",
    "integration.status.v1",
    "usage.observed.v1",
  ]) {
    if (!topics.split(/\r?\n/).includes(topic)) {
      throw new Error(`Kafka topic missing: ${topic}`);
    }
  }
}

console.log(
  "Core infrastructure checks passed. Not a load/failover or end-to-end product certification.",
);
