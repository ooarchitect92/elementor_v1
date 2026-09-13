-- WordPress Compatibility Passport persistence.
BEGIN;

CREATE TABLE IF NOT EXISTS wordpress_compatibility_passports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "websiteId" uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  "connectionId" uuid NOT NULL REFERENCES wordpress_connections(id) ON DELETE CASCADE,
  "importRunId" uuid REFERENCES wordpress_import_runs(id) ON DELETE SET NULL,
  "sourceFingerprint" char(64) NOT NULL CHECK("sourceFingerprint" ~ '^[0-9a-f]{64}$'),
  score integer NOT NULL CHECK(score BETWEEN 0 AND 100),
  grade text NOT NULL CHECK(grade IN ('A','B','C','D','E')),
  "migrationMode" text NOT NULL CHECK("migrationMode" IN ('DIRECT','ASSISTED','HEADLESS_RETAIN','REBUILD_RECOMMENDED')),
  summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object'),
  findings jsonb NOT NULL CHECK(jsonb_typeof(findings)='array'),
  "generatedBy" uuid NOT NULL REFERENCES users(id),
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE("connectionId","sourceFingerprint")
);
CREATE INDEX IF NOT EXISTS wordpress_passports_latest_idx
  ON wordpress_compatibility_passports("websiteId","connectionId","createdAt" DESC);

COMMIT;
