import { createClient } from "redis";
import type { RedisPort } from "./redis.ts";
import {
  redisConnectionString,
  type RedisRole,
  type RuntimeEnvironment,
} from "./runtime-config.ts";

type RedisClient = ReturnType<typeof createClient>;

export interface ConnectedRedis {
  readonly role: RedisRole;
  readonly client: RedisClient;
  readonly port: RedisPort;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export async function connectRedis(
  role: RedisRole,
  environment: RuntimeEnvironment = process.env,
): Promise<ConnectedRedis> {
  const client = createClient({
    url: redisConnectionString(role, environment),
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy(retries: number) {
        if (retries >= 12) return new Error(`REDIS_${role.toUpperCase()}_UNAVAILABLE`);
        return Math.min(2_000, 50 * 2 ** Math.min(retries, 6));
      },
    },
  });

  // node-redis treats an unhandled error event as fatal. Runtime owners can attach
  // telemetry separately; this listener deliberately avoids logging credentials/URLs.
  client.on("error", () => undefined);
  await client.connect();
  await client.ping();

  const port: RedisPort = {
    async get(key) {
      return client.get(key);
    },
    async set(key, value, options) {
      return client.set(key, value, options);
    },
    async eval(script, options) {
      return client.eval(script, options);
    },
  };

  return {
    role,
    client,
    port,
    async ping() {
      if (!client.isReady) throw new Error(`REDIS_${role.toUpperCase()}_NOT_READY`);
      const response = await client.ping();
      if (response !== "PONG") throw new Error(`REDIS_${role.toUpperCase()}_BAD_RESPONSE`);
    },
    async close() {
      if (client.isOpen) await client.close();
    },
  };
}
