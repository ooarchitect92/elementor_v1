# Migration and privilege boundary
`001_platform.sql` is an additive foundation migration for a **fresh** database. It deliberately
fails if reapplied rather than hiding drift. It does not alter legacy tables or backfill memberships.
Apply explicitly to an existing environment only after DBA review and a tested backup/restore.
Do not run `prisma db push` against a populated environment to install this separate schema.

The local Compose database uses a bootstrap superuser. It is NOT a production application role.
Production needs separate migration, API, outbox-worker and operational roles. API roles must have
NOBYPASSRLS, no ownership, no DDL and no ability to SET ROLE to a privileged role. Grant only required
DML in this schema. The audit writer receives INSERT/SELECT, not UPDATE/DELETE. Worker roles are
isolated from public API credentials; cross-tenant claim queries require explicitly reviewed privileges.

Every API transaction sets `app.tenant_id` using `set_config(..., true)` after verifying the session
and membership. No request-provided tenant header is sufficient. Connections return to their pool
only after COMMIT/ROLLBACK. PostgreSQL is authoritative; Redis and broker state cannot grant access.

Run `tests/integration/platform.sql` only in a disposable database. It creates a temporary test role
within a transaction, tests real RLS under that nonprivileged role, then rolls everything back.
Legacy user IDs are referenced as UUID values for future mapping, not foreign keys into an assumed
legacy schema. F02 owns the reviewed migration/backfill into the actual application.
