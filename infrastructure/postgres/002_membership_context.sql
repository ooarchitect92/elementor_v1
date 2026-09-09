-- F02 additive security migration for authenticated membership discovery.
-- This migration does not create tenants or backfill legacy websites/users.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform.schema_versions WHERE version = 2
  ) THEN
    -- Membership lookup is the bootstrap step before a tenant-scoped transaction.
    -- app.user_id must be set transaction-locally by server code from the verified
    -- authenticated session. Request JSON/header values are never copied here.
    CREATE POLICY membership_self_discovery
      ON platform.memberships
      FOR SELECT
      USING (
        user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      );

    INSERT INTO platform.schema_versions(version) VALUES(2);
  END IF;
END $$;

COMMIT;
