-- Explicit additive migration. No legacy user/site backfill and no startup DDL.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform.schema_versions WHERE version = 3) THEN
    CREATE TABLE platform.workspaces (
      tenant_id uuid NOT NULL REFERENCES platform.tenants(id), id uuid NOT NULL,
      name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
      slug text NOT NULL CHECK(length(slug) BETWEEN 1 AND 63 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
      version bigint NOT NULL DEFAULT 1 CHECK(version > 0), created_by uuid NOT NULL,
      create_key uuid NOT NULL, create_name text NOT NULL, create_slug text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,slug), UNIQUE(tenant_id,create_key)
    );
    ALTER TABLE platform.workspaces ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform.workspaces FORCE ROW LEVEL SECURITY;
    CREATE POLICY workspace_read ON platform.workspaces FOR SELECT USING (
      tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid AND EXISTS (
        SELECT 1 FROM platform.memberships m JOIN platform.tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=workspaces.tenant_id AND m.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
          AND m.status='ACTIVE' AND t.status='ACTIVE' AND m.role IN ('OWNER','ADMIN','EDITOR','PUBLISHER','VIEWER')
      )
    );
    CREATE POLICY workspace_create ON platform.workspaces FOR INSERT WITH CHECK (
      tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid
      AND created_by = NULLIF(current_setting('app.user_id',true),'')::uuid AND EXISTS (
        SELECT 1 FROM platform.memberships m JOIN platform.tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=workspaces.tenant_id AND m.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
          AND m.status='ACTIVE' AND t.status='ACTIVE' AND m.role IN ('OWNER','ADMIN')
      )
    );
    CREATE POLICY workspace_update ON platform.workspaces FOR UPDATE USING (
      tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid AND EXISTS (
        SELECT 1 FROM platform.memberships m JOIN platform.tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=workspaces.tenant_id AND m.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
          AND m.status='ACTIVE' AND t.status='ACTIVE' AND m.role IN ('OWNER','ADMIN')
      )
    );
    -- No DELETE policy. Creation receipts remain available after archive/rename.
    INSERT INTO platform.schema_versions(version) VALUES(3);
  ELSIF to_regclass('platform.workspaces') IS NULL THEN
    RAISE EXCEPTION 'Workspace schema version exists but table is missing';
  END IF;
END $$;
COMMIT;
