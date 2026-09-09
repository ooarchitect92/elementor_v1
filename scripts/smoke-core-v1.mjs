import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const smokeDb = "forgestudio_core_v1_smoke";
const migration = readFileSync("backend/prisma/manual/003_core_v1.sql", "utf8");

function docker(args, input) {
  const result = spawnSync("docker", ["compose", ...args], {
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function psql(database, sql) {
  return docker([
    "exec", "-T", "postgres", "sh", "-lc",
    `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ${database}`,
  ], sql);
}

try {
  // This script owns only this fixed disposable database name. It never drops the developer database.
  docker(["exec", "-T", "postgres", "sh", "-lc", `dropdb -U "$POSTGRES_USER" --if-exists ${smokeDb} && createdb -U "$POSTGRES_USER" ${smokeDb}`]);

  psql(smokeDb, `
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      email text
    );
    CREATE TABLE websites (
      id uuid PRIMARY KEY,
      "userId" uuid NOT NULL REFERENCES users(id),
      name text NOT NULL,
      slug text NOT NULL,
      status text NOT NULL DEFAULT 'DRAFT',
      "editorData" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO users(id,email) VALUES ('11111111-1111-4111-8111-111111111111','fixture@example.invalid');
    INSERT INTO websites(id,"userId",name,slug,"editorData") VALUES (
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      'Fixture',
      'fixture',
      '{"version":1,"elements":[{"id":"hero","content":"hello"}]}'::jsonb
    );
  `);

  psql(smokeDb, migration);

  const verification = psql(smokeDb, `
    DO $$
    DECLARE
      revision_count integer;
      current_revision bigint;
      table_count integer;
    BEGIN
      SELECT count(*) INTO revision_count
      FROM website_revisions
      WHERE "websiteId"='22222222-2222-4222-8222-222222222222'::uuid AND revision=0;
      IF revision_count <> 1 THEN RAISE EXCEPTION 'initial revision backfill failed'; END IF;

      SELECT "currentRevision" INTO current_revision
      FROM websites WHERE id='22222222-2222-4222-8222-222222222222'::uuid;
      IF current_revision <> 0 THEN RAISE EXCEPTION 'currentRevision default invalid'; END IF;

      SELECT count(*) INTO table_count FROM pg_class
      WHERE relkind='r' AND relname IN (
        'website_revisions','site_releases','wordpress_connections',
        'wordpress_import_runs','wordpress_source_snapshots'
      );
      IF table_count <> 5 THEN RAISE EXCEPTION 'core v1 tables missing: %', table_count; END IF;
    END $$;

    INSERT INTO site_releases(
      "websiteId","releaseNumber","sourceRevision","requestKey","requestHash","contentHash",payload,status,"createdBy"
    ) VALUES (
      '22222222-2222-4222-8222-222222222222',1,0,'smoke-request-key-0001',repeat('a',64),repeat('b',64),'{}'::jsonb,'ACTIVE','11111111-1111-4111-8111-111111111111'
    );

    DO $$ BEGIN
      BEGIN
        INSERT INTO site_releases(
          "websiteId","releaseNumber","sourceRevision","requestKey","requestHash","contentHash",payload,status,"createdBy"
        ) VALUES (
          '22222222-2222-4222-8222-222222222222',2,0,'smoke-request-key-0002',repeat('c',64),repeat('d',64),'{}'::jsonb,'ACTIVE','11111111-1111-4111-8111-111111111111'
        );
        RAISE EXCEPTION 'expected single-active-release constraint';
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
    END $$;

    SELECT 'PASS: core v1 migration/backfill/active-release constraints' AS result;
  `);
  process.stdout.write(verification);
} finally {
  try {
    docker(["exec", "-T", "postgres", "sh", "-lc", `dropdb -U "$POSTGRES_USER" --if-exists --force ${smokeDb}`]);
  } catch (cleanupError) {
    console.error(String(cleanupError));
  }
}
