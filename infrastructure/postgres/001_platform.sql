-- Additive foundation schema. Does NOT migrate legacy users/websites or run at API startup.
-- Fresh local volumes apply this once. Existing DBs require a reviewed explicit migration.
BEGIN;
CREATE SCHEMA IF NOT EXISTS platform;
CREATE TABLE platform.schema_versions(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE platform.tenants (
  id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','DELETED')),
  home_cell text NOT NULL DEFAULT 'local-1', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform.memberships (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id), user_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('OWNER','ADMIN','EDITOR','PUBLISHER','VIEWER')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED')),
  version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE platform.jobs (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id), id uuid NOT NULL,
  job_type text NOT NULL CHECK(job_type IN ('publish.build','wordpress.sync','media.process','integration.deliver','maintenance.reconcile')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  payload_ref text NOT NULL,
  state text NOT NULL CHECK(state IN ('ACCEPTED','QUEUED','RUNNING','RETRY_SCHEDULED','SUCCEEDED','FAILED_PERMANENTLY','OUTCOME_UNKNOWN','CANCELLED')),
  side_effects text NOT NULL DEFAULT 'non-idempotent' CHECK(side_effects IN ('none','idempotent','non-idempotent')),
  attempt integer NOT NULL DEFAULT 0 CHECK(attempt >= 0), max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL DEFAULT now(), deadline timestamptz NOT NULL,
  lease_token uuid, lease_until timestamptz, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,job_type,idempotency_key),
  CHECK((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK(state <> 'RUNNING' OR lease_token IS NOT NULL)
);
CREATE INDEX jobs_due ON platform.jobs(available_at) WHERE state IN ('ACCEPTED','RETRY_SCHEDULED');
CREATE INDEX jobs_expired_lease ON platform.jobs(lease_until) WHERE state='RUNNING';
CREATE TABLE platform.job_attempts (
  tenant_id uuid NOT NULL, job_id uuid NOT NULL, attempt integer NOT NULL,
  lease_token uuid NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  outcome text, error_code text,
  PRIMARY KEY(tenant_id,job_id,attempt), UNIQUE(tenant_id,lease_token),
  FOREIGN KEY(tenant_id,job_id) REFERENCES platform.jobs(tenant_id,id)
);
CREATE TABLE platform.outbox_events (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id), event_id uuid NOT NULL,
  aggregate_id uuid NOT NULL, aggregate_version bigint NOT NULL CHECK(aggregate_version >= 0),
  event_type text NOT NULL, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,event_id)
);
CREATE TABLE platform.outbox_deliveries (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL,
  destination text NOT NULL CHECK(destination IN ('rabbitmq','kafka')),
  body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SENT','FAILED')),
  attempt integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_until timestamptz, sent_at timestamptz, error_code text,
  PRIMARY KEY(tenant_id,event_id,destination),
  FOREIGN KEY(tenant_id,event_id) REFERENCES platform.outbox_events(tenant_id,event_id),
  CHECK((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX outbox_due ON platform.outbox_deliveries(destination,available_at) WHERE state='PENDING';
CREATE TABLE platform.consumer_inbox (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id), consumer text NOT NULL,
  event_id uuid NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,consumer,event_id)
);
CREATE TABLE platform.audit_events (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id), id uuid NOT NULL,
  actor_id uuid NOT NULL, action text NOT NULL, resource_id uuid,
  trace_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id)
);
-- Policy is an extra boundary, not a replacement for membership checks.
ALTER TABLE platform.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON platform.tenants USING(id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','jobs','job_attempts','outbox_events','outbox_deliveries','consumer_inbox','audit_events'] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($policy$CREATE POLICY tenant_scope ON platform.%I USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$, t);
  END LOOP;
END $$;
INSERT INTO platform.schema_versions(version) VALUES(1);
COMMIT;
