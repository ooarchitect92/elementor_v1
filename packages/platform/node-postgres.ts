import { Pool } from "pg";
import type { Pool as PoolType, PoolClient, QueryResultRow } from "pg";
import type { SqlConnection, SqlPool } from "../../workers/shared/postgres.ts";
import {
  integerEnvironment,
  postgresConnectionString,
  type RuntimeEnvironment,
} from "./runtime-config.ts";


class PostgresConnection implements SqlConnection {
  private readonly client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    const result = await this.client.query<QueryResultRow>(sql, values);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount,
    };
  }

  release(destroy = false): void {
    this.client.release(destroy);
  }
}

export class NodePostgresPool implements SqlPool {
  readonly pool: PoolType;

  constructor(environment: RuntimeEnvironment = process.env) {
    this.pool = new Pool({
      connectionString: postgresConnectionString(environment),
      min: integerEnvironment(environment, "POSTGRES_POOL_MIN", 0, 0, 100),
      max: integerEnvironment(environment, "POSTGRES_POOL_MAX", 10, 1, 200),
      connectionTimeoutMillis: integerEnvironment(
        environment,
        "POSTGRES_CONNECT_TIMEOUT_MS",
        5_000,
        100,
        60_000,
      ),
      idleTimeoutMillis: integerEnvironment(
        environment,
        "POSTGRES_IDLE_TIMEOUT_MS",
        30_000,
        1_000,
        600_000,
      ),
      allowExitOnIdle: false,
      application_name: environment.SERVICE_NAME?.trim() || "forgestudio-worker",
    });
    this.pool.on("error", () => undefined);
  }

  async connect(): Promise<SqlConnection> {
    return new PostgresConnection(await this.pool.connect());
  }

  async ping(): Promise<void> {
    const result = await this.pool.query<{ ok: number }>("SELECT 1 AS ok");
    if (result.rows[0]?.ok !== 1) throw new Error("POSTGRES_BAD_RESPONSE");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
