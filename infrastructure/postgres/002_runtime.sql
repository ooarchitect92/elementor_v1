-- Runtime worker upgrade. Existing databases must apply this reviewed migration explicitly.
BEGIN;

ALTER TABLE platform.jobs
  ADD COLUMN IF NOT EXISTS trace_id uuid;

-- Historical development rows predate trace persistence. They receive a synthetic trace
-- exactly once; newly accepted jobs always persist their originating trace.
UPDATE platform.jobs
SET trace_id = gen_random_uuid()
WHERE trace_id IS NULL;

ALTER TABLE platform.jobs
  ALTER COLUMN trace_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_tenant_due
  ON platform.jobs(tenant_id, available_at, id)
  WHERE state IN ('ACCEPTED','QUEUED','RETRY_SCHEDULED');

CREATE INDEX IF NOT EXISTS jobs_tenant_expired_lease
  ON platform.jobs(tenant_id, lease_until, id)
  WHERE state='RUNNING';

CREATE INDEX IF NOT EXISTS outbox_tenant_due
  ON platform.outbox_deliveries(tenant_id, destination, available_at, event_id)
  WHERE state='PENDING';

INSERT INTO platform.schema_versions(version)
VALUES(2)
ON CONFLICT(version) DO NOTHING;

COMMIT;
