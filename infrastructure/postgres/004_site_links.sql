-- Additive PR #14-chain migration; apply explicitly after platform schema 1/2/3
-- AND the reviewed legacy public.websites schema. Never executed at API startup.
-- Refuse a reused version number; reconcile the parallel core-v1 migrations first.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform.schema_versions WHERE version=3)
    OR to_regclass('platform.workspaces') IS NULL OR to_regclass('public.websites') IS NULL THEN
    RAISE EXCEPTION 'Workspace v3 and legacy website schema must exist before site links';
  END IF;
  IF EXISTS(SELECT 1 FROM platform.schema_versions WHERE version=4) THEN
    RAISE EXCEPTION 'Schema version 4 is already used: verify migration lineage before proceeding';
  END IF;
END $$;
CREATE TABLE platform.site_links (
  site_id uuid PRIMARY KEY REFERENCES public.websites(id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE, tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,workspace_id) REFERENCES platform.workspaces(tenant_id,id)
);
CREATE INDEX site_links_workspace ON platform.site_links(tenant_id,workspace_id,site_id);
ALTER TABLE platform.site_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_links FORCE ROW LEVEL SECURITY;
CREATE POLICY site_link_read ON platform.site_links FOR SELECT USING (
  tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
  AND EXISTS (SELECT 1 FROM public.websites s JOIN public.users u ON u.id=s."userId"
    WHERE s.id=site_links.site_id AND u.id=NULLIF(current_setting('app.user_id',true),'')::uuid AND u.status='ACTIVE')
  AND EXISTS (SELECT 1 FROM platform.memberships m JOIN platform.tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=site_links.tenant_id AND m.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
      AND m.status='ACTIVE' AND t.status='ACTIVE' AND m.role IN ('OWNER','ADMIN','EDITOR','PUBLISHER','VIEWER'))
);
CREATE POLICY site_link_insert ON platform.site_links FOR INSERT WITH CHECK (
  tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
  AND EXISTS (SELECT 1 FROM public.websites s JOIN public.users u ON u.id=s."userId"
    WHERE s.id=site_links.site_id AND u.id=NULLIF(current_setting('app.user_id',true),'')::uuid AND u.status='ACTIVE')
  AND EXISTS (SELECT 1 FROM platform.memberships m JOIN platform.tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=site_links.tenant_id AND m.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
      AND m.status='ACTIVE' AND t.status='ACTIVE' AND m.role IN ('OWNER','ADMIN'))
  AND created_by=NULLIF(current_setting('app.user_id',true),'')::uuid
  AND EXISTS (SELECT 1 FROM platform.workspaces w WHERE w.tenant_id=site_links.tenant_id AND w.id=site_links.workspace_id AND w.status='ACTIVE')
);
CREATE POLICY site_link_delete ON platform.site_links FOR DELETE USING (
  tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
  AND EXISTS (SELECT 1 FROM public.websites s JOIN public.users u ON u.id=s."userId"
    WHERE s.id=site_links.site_id AND u.id=NULLIF(current_setting('app.user_id',true),'')::uuid AND u.status='ACTIVE')
  AND EXISTS (SELECT 1 FROM platform.memberships m JOIN platform.tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=site_links.tenant_id AND m.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid
      AND m.status='ACTIVE' AND t.status='ACTIVE' AND m.role IN ('OWNER','ADMIN'))
);
-- No UPDATE policy; link identity cannot be rewritten. A move requires a reviewed
-- unlink of the exact current UUID followed by a separate attach.
REVOKE ALL ON platform.site_links FROM PUBLIC;
INSERT INTO platform.schema_versions(version) VALUES(4);
COMMIT;
