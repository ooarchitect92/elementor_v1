-- Durable trusted form-delivery runtime.
-- Apply explicitly after 001_platform.sql, 002_runtime.sql, and 003_job_resources.sql.
BEGIN;

CREATE TABLE IF NOT EXISTS platform.integration_delivery_resources (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  website_id uuid NOT NULL,
  release_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  action_type text NOT NULL CHECK(action_type IN ('EMAIL','WEBHOOK','CRM')),
  action_index integer NOT NULL CHECK(action_index BETWEEN 0 AND 31),
  provider text NOT NULL CHECK(provider ~ '^[A-Z0-9_.-]{1,80}$'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  config_ciphertext text NOT NULL,
  config_iv text NOT NULL,
  config_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1 CHECK(key_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id, job_id),
  UNIQUE(tenant_id, submission_id, action_type, action_index),
  FOREIGN KEY(tenant_id, job_id)
    REFERENCES platform.jobs(tenant_id, id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS integration_delivery_submission_history
  ON platform.integration_delivery_resources(tenant_id, submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS integration_delivery_website_history
  ON platform.integration_delivery_resources(tenant_id, website_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform.integration_receipts (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider ~ '^[A-Z0-9_.-]{1,80}$'),
  provider_reference text,
  http_status integer CHECK(http_status IS NULL OR http_status BETWEEN 100 AND 599),
  response_digest char(64) NOT NULL CHECK(response_digest ~ '^[0-9a-f]{64}$'),
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id, job_id),
  FOREIGN KEY(tenant_id, job_id)
    REFERENCES platform.jobs(tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform.integration_delivery_issues (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  website_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  action_name text NOT NULL CHECK(action_name ~ '^[a-z0-9_.-]{1,80}$'),
  code text NOT NULL CHECK(code ~ '^[A-Z0-9_.:-]{1,80}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS integration_delivery_issues_open
  ON platform.integration_delivery_issues(tenant_id, website_id, created_at DESC)
  WHERE resolved_at IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'integration_delivery_resources',
    'integration_receipts',
    'integration_delivery_issues'
  ] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='platform' AND tablename=table_name AND policyname='tenant_scope'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_scope ON platform.%I USING(tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',
        table_name
      );
    END IF;
  END LOOP;
END $$;

INSERT INTO platform.schema_versions(version)
VALUES(4)
ON CONFLICT(version) DO NOTHING;

COMMIT;
