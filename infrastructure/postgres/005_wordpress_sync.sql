-- Conflict-safe WordPress write synchronization runtime.
BEGIN;

CREATE TABLE IF NOT EXISTS platform.wordpress_sync_resources (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  website_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  source_type text NOT NULL CHECK(source_type IN ('page','post')),
  source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 64),
  expected_modified_gmt text NOT NULL CHECK(length(expected_modified_gmt) BETWEEN 1 AND 40),
  expected_hash char(64) NOT NULL CHECK(expected_hash ~ '^[0-9a-f]{64}$'),
  desired_payload jsonb NOT NULL CHECK(jsonb_typeof(desired_payload)='object'),
  endpoint_url text NOT NULL,
  username text NOT NULL,
  credential_ciphertext text NOT NULL,
  credential_iv text NOT NULL,
  credential_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1 CHECK(key_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,job_id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES platform.jobs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS wordpress_sync_resources_site
  ON platform.wordpress_sync_resources(tenant_id,website_id,connection_id,created_at DESC);

CREATE TABLE IF NOT EXISTS platform.wordpress_sync_receipts (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  source_type text NOT NULL CHECK(source_type IN ('page','post')),
  source_id text NOT NULL,
  source_hash char(64) NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  source_modified_gmt text NOT NULL,
  source_status text NOT NULL,
  replayed boolean NOT NULL DEFAULT false,
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,job_id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES platform.jobs(tenant_id,id) ON DELETE CASCADE
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['wordpress_sync_resources','wordpress_sync_receipts'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY',table_name);
    IF NOT EXISTS(
      SELECT 1 FROM pg_policies
      WHERE schemaname='platform' AND tablename=table_name AND policyname='tenant_scope'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_scope ON platform.%I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',
        table_name
      );
    END IF;
  END LOOP;
END $$;

INSERT INTO platform.schema_versions(version) VALUES(5) ON CONFLICT(version) DO NOTHING;
COMMIT;
