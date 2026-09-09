import { uuid } from "../events/index.ts";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function requiredEnvironment(
  environment: RuntimeEnvironment,
  name: string,
): string {
  const value = clean(environment[name]);
  if (!value) throw new Error(`MISSING_ENVIRONMENT:${name}`);
  return value;
}

export function integerEnvironment(
  environment: RuntimeEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = clean(environment[name]);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`INVALID_ENVIRONMENT:${name}`);
  }
  return value;
}

function validatedUrl(raw: string, protocols: readonly string[], name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`INVALID_ENVIRONMENT:${name}`);
  }
  if (!protocols.includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`INVALID_ENVIRONMENT:${name}`);
  }
  return parsed;
}

export function postgresConnectionString(
  environment: RuntimeEnvironment = process.env,
): string {
  const explicit = clean(environment.PLATFORM_DATABASE_URL) ?? clean(environment.DATABASE_URL);
  if (explicit) {
    return validatedUrl(explicit, ["postgres:", "postgresql:"], "PLATFORM_DATABASE_URL").toString();
  }

  const host = clean(environment.POSTGRES_HOST) ?? "127.0.0.1";
  const port = integerEnvironment(environment, "POSTGRES_PORT", 5432, 1, 65535);
  const database = clean(environment.POSTGRES_DB) ?? "forgestudio";
  const user = clean(environment.POSTGRES_USER) ?? "forgestudio";
  const password = requiredEnvironment(environment, "POSTGRES_PASSWORD");
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

export type RedisRole = "cache" | "control";

export function redisConnectionString(
  role: RedisRole,
  environment: RuntimeEnvironment = process.env,
): string {
  const explicitName = role === "cache" ? "REDIS_CACHE_URL" : "REDIS_CONTROL_URL";
  const explicit = clean(environment[explicitName]);
  if (explicit) {
    return validatedUrl(explicit, ["redis:", "rediss:"], explicitName).toString();
  }

  const host = clean(environment.REDIS_HOST) ?? "127.0.0.1";
  const portName = role === "cache" ? "REDIS_CACHE_PORT" : "REDIS_CONTROL_PORT";
  const port = integerEnvironment(environment, portName, role === "cache" ? 6379 : 6380, 1, 65535);
  const password = requiredEnvironment(environment, "REDIS_PASSWORD");
  return `redis://:${encodeURIComponent(password)}@${host}:${port}/0`;
}

export function rabbitConnectionString(
  environment: RuntimeEnvironment = process.env,
): string {
  const explicit = clean(environment.RABBITMQ_URL);
  if (explicit) {
    return validatedUrl(explicit, ["amqp:", "amqps:"], "RABBITMQ_URL").toString();
  }

  const host = clean(environment.RABBITMQ_HOST) ?? "127.0.0.1";
  const port = integerEnvironment(environment, "RABBITMQ_PORT", 5672, 1, 65535);
  const user = clean(environment.RABBITMQ_USER) ?? "forgestudio";
  const password = requiredEnvironment(environment, "RABBITMQ_PASSWORD");
  const vhost = clean(environment.RABBITMQ_VHOST) ?? "/";
  const encodedVhost = vhost === "/" ? "%2F" : encodeURIComponent(vhost.replace(/^\/+/, ""));
  return `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodedVhost}`;
}

export function kafkaBrokerList(
  environment: RuntimeEnvironment = process.env,
): string[] {
  const explicit = clean(environment.KAFKA_BROKERS);
  const brokers = explicit
    ? explicit.split(",").map((value) => value.trim()).filter(Boolean)
    : [`127.0.0.1:${integerEnvironment(environment, "KAFKA_PORT", 9094, 1, 65535)}`];

  if (brokers.length < 1 || brokers.length > 16) {
    throw new Error("INVALID_ENVIRONMENT:KAFKA_BROKERS");
  }
  for (const broker of brokers) {
    if (!/^[A-Za-z0-9._-]+:\d{1,5}$/.test(broker)) {
      throw new Error("INVALID_ENVIRONMENT:KAFKA_BROKERS");
    }
    const port = Number(broker.slice(broker.lastIndexOf(":") + 1));
    if (port < 1 || port > 65535) throw new Error("INVALID_ENVIRONMENT:KAFKA_BROKERS");
  }
  return brokers;
}

export function workerTenantIds(
  environment: RuntimeEnvironment = process.env,
): string[] {
  const raw = clean(environment.WORKER_TENANT_IDS) ?? clean(environment.TENANT_ID);
  if (!raw) throw new Error("MISSING_ENVIRONMENT:WORKER_TENANT_IDS");
  const values = [...new Set(raw.split(",").map((value) => uuid(value.trim())))];
  if (values.length < 1 || values.length > 1000) {
    throw new Error("INVALID_ENVIRONMENT:WORKER_TENANT_IDS");
  }
  return values;
}
