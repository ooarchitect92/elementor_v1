import test from "node:test";
import assert from "node:assert/strict";
import {
  integerEnvironment,
  kafkaBrokerList,
  postgresConnectionString,
  rabbitConnectionString,
  redisConnectionString,
  workerTenantIds,
} from "../../packages/platform/runtime-config.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";

test("runtime connection strings encode credentials without logging them", () => {
  const environment = {
    POSTGRES_PASSWORD: "p@ss:/word",
    REDIS_PASSWORD: "redis p@ss",
    RABBITMQ_PASSWORD: "rabbit/p@ss",
  };
  assert.match(postgresConnectionString(environment), /p%40ss%3A%2Fword/);
  assert.match(redisConnectionString("control", environment), /redis%20p%40ss/);
  assert.match(rabbitConnectionString(environment), /rabbit%2Fp%40ss/);
});

test("explicit runtime URLs reject unrelated protocols", () => {
  assert.throws(
    () => postgresConnectionString({ PLATFORM_DATABASE_URL: "https://example.invalid" }),
    /INVALID_ENVIRONMENT/,
  );
  assert.throws(
    () => redisConnectionString("cache", { REDIS_CACHE_URL: "http://example.invalid" }),
    /INVALID_ENVIRONMENT/,
  );
  assert.throws(
    () => rabbitConnectionString({ RABBITMQ_URL: "redis://example.invalid" }),
    /INVALID_ENVIRONMENT/,
  );
});

test("Kafka brokers and worker tenant scopes are bounded", () => {
  assert.deepEqual(
    kafkaBrokerList({ KAFKA_BROKERS: "broker-a:9092,broker-b:9092" }),
    ["broker-a:9092", "broker-b:9092"],
  );
  assert.throws(
    () => kafkaBrokerList({ KAFKA_BROKERS: "https://broker-a:9092" }),
    /INVALID_ENVIRONMENT/,
  );
  assert.deepEqual(workerTenantIds({ WORKER_TENANT_IDS: `${TENANT},${TENANT}` }), [TENANT]);
  assert.throws(() => workerTenantIds({ WORKER_TENANT_IDS: "not-a-uuid" }));
});

test("numeric runtime settings fail closed outside declared bounds", () => {
  assert.equal(integerEnvironment({}, "LIMIT", 10, 1, 20), 10);
  assert.throws(
    () => integerEnvironment({ LIMIT: "1000" }, "LIMIT", 10, 1, 20),
    /INVALID_ENVIRONMENT:LIMIT/,
  );
  assert.throws(
    () => integerEnvironment({ LIMIT: "1.5" }, "LIMIT", 10, 1, 20),
    /INVALID_ENVIRONMENT:LIMIT/,
  );
});
