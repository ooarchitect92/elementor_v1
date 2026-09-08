-- Disposable DB only. All fixture data and the role are rolled back.
BEGIN;
INSERT INTO platform.tenants(id,name) VALUES
('11111111-1111-4111-8111-111111111111','Fixture A'),('22222222-2222-4222-8222-222222222222','Fixture B');
INSERT INTO platform.memberships(tenant_id,user_id,role) VALUES
('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','OWNER'),
('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','VIEWER');
CREATE ROLE foundation_test_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA platform TO foundation_test_role;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA platform TO foundation_test_role;
SET LOCAL ROLE foundation_test_role;
SELECT set_config('app.tenant_id','11111111-1111-4111-8111-111111111111',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM platform.tenants) <> 1 THEN RAISE EXCEPTION 'Tenant read isolation failed'; END IF;
  IF (SELECT count(*) FROM platform.memberships) <> 1 THEN RAISE EXCEPTION 'Membership isolation failed'; END IF;
  BEGIN
    INSERT INTO platform.memberships(tenant_id,user_id,role) VALUES('22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','OWNER');
    RAISE EXCEPTION 'Cross-tenant write unexpectedly allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SELECT set_config('app.tenant_id','',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM platform.memberships) <> 0 THEN RAISE EXCEPTION 'Missing context must deny reads'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
SELECT 'PASS: tenant RLS read/write and missing-context checks' AS result;
