-- Durable, immutable resources associated with platform jobs.
-- Existing databases must apply the matching reviewed backend migration explicitly.
BEGIN;

CREATE TABLE IF NOT EXISTS platform.job_resources (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  resource_type text NOT NULL CHECK(resource_type IN ('WEBSITE_PUBLISH')),
  resource_id uuid NOT NULL,
  source_revision bigint NOT NULL CHECK(source_revision >= 0),
  source_hash char(64) NOT NULL,
  source_payload jsonb NOT NULL,
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id, job_id),
  FOREIGN KEY(tenant_id, job_id)
    REFERENCES platform.jobs(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT job_resources_source_hash_format CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT job_resources_source_payload_object CHECK(jsonb_typeof(source_payload)='object')
);

ALTER TABLE platform.job_resources
  ADD COLUMN IF NOT EXISTS source_hash char(64),
  ADD COLUMN IF NOT EXISTS source_payload jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM platform.job_resources
    WHERE source_hash IS NULL OR source_payload IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing job_resources rows require explicit immutable publish-snapshot backfill';
  END IF;
END $$;

ALTER TABLE platform.job_resources
  ALTER COLUMN source_hash SET NOT NULL,
  ALTER COLUMN source_payload SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='job_resources_source_hash_format') THEN
    ALTER TABLE platform.job_resources
      ADD CONSTRAINT job_resources_source_hash_format CHECK(source_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='job_resources_source_payload_object') THEN
    ALTER TABLE platform.job_resources
      ADD CONSTRAINT job_resources_source_payload_object CHECK(jsonb_typeof(source_payload)='object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS job_resources_website_history
  ON platform.job_resources(tenant_id, resource_id, created_at DESC);

ALTER TABLE platform.job_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.job_resources FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='platform'
      AND tablename='job_resources'
      AND policyname='tenant_scope'
  ) THEN
    CREATE POLICY tenant_scope ON platform.job_resources
      USING(tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK(tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

INSERT INTO platform.schema_versions(version)
VALUES(3)
ON CONFLICT(version) DO NOTHING;

COMMIT;
