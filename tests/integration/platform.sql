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

-- Tenant-scoped access remains isolated.
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

-- Without any context, reads fail closed.
SELECT set_config('app.tenant_id','',true);
SELECT set_config('app.user_id','',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM platform.memberships) <> 0 THEN RAISE EXCEPTION 'Missing context must deny membership reads'; END IF;
  IF (SELECT count(*) FROM platform.tenants) <> 0 THEN RAISE EXCEPTION 'Missing context must deny tenant reads'; END IF;
END $$;

-- Authenticated membership discovery exposes memberships for that verified user only.
SELECT set_config('app.user_id','33333333-3333-4333-8333-333333333333',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM platform.memberships) <> 2 THEN RAISE EXCEPTION 'Self membership discovery failed'; END IF;
  IF (SELECT count(*) FROM platform.tenants) <> 0 THEN RAISE EXCEPTION 'Membership discovery must not expose tenant rows'; END IF;
END $$;

-- A different verified user cannot discover someone else's memberships.
SELECT set_config('app.user_id','44444444-4444-4444-8444-444444444444',true);
DO $$ BEGIN
  IF (SELECT count(*) FROM platform.memberships) <> 0 THEN RAISE EXCEPTION 'Cross-user membership discovery failed closed'; END IF;
END $$;

RESET ROLE;
ROLLBACK;
SELECT 'PASS: tenant RLS, membership self-discovery and fail-closed checks' AS result;
