# Tenant workspaces — API increment

Routes are mounted by the existing tenancy router at both `/api/v1/tenancy/workspaces`
and `/api/tenancy/workspaces`. The first is canonical. This increment does not move
legacy websites into workspaces, create tenants automatically, or add a frontend screen.
An active user/session and a deliberately provisioned active membership are prerequisites.

| Method | Path relative to the workspace base | Behavior |
| --- | --- | --- |
| GET | `/` | All five existing tenant roles can list; `limit` defaults to 50, max 100; `after` is the prior page's UUID cursor. Includes archived workspaces. |
| GET | `/:workspaceId` | Read one workspace within the verified tenant; inaccessible IDs return 404. |
| POST | `/` | OWNER/ADMIN creates a workspace and an audit event in one database transaction. |
| PATCH | `/:workspaceId` | OWNER/ADMIN renames, archives or reactivates with an expected version. |

The existing `forge_session` cookie authenticates requests. `x-forgestudio-tenant`
is only a selector checked against persisted membership, not user/tenant authority.
For one active membership the existing selector middleware can choose automatically;
multiple memberships still require explicit selection. No endpoint accepts a user,
tenant or creator identity in its body. Roles from an earlier middleware result do not
authorize workspace operations: session, account, tenant and membership are re-read
and locked in the transaction. An already-authorized in-flight operation can finish
before a concurrent revocation commits; operations beginning after revocation are denied.

## Mutations

Every POST/PATCH requires `Origin` exactly equal to the configured `FRONTEND_URL`
origin, `X-ForgeStudio-Request: workspace-v1`, and `Content-Type: application/json`.
The marker is a CSRF defense, not a password or authorization token. Browser requests
supply Origin automatically; authenticated terminal clients must provide it explicitly.
Production configuration requires HTTPS. Missing/invalid configuration disables writes.
This guard is scoped to new workspace endpoints; legacy CSRF remediation remains F04 work.

POST additionally requires a UUID `Idempotency-Key`. Keep that key unchanged when
retrying an uncertain request. A repeated key and normalized payload returns the exact
original workspace creation receipt (201, `Idempotent-Replayed: true`), even if the
workspace was subsequently renamed/archived. GET returns its latest state. Key reuse
with different content returns 409; tenant/slug collisions with a new key return 409.
Creation receipt columns are never exposed. A slug is immutable and remains reserved
when archived. No DELETE endpoint or hard-delete policy is provided.

```json
{"name":"Marketing","slug":"marketing"}
```

PATCH requires a positive decimal STRING version, and at least name or status:

```json
{"name":"Marketing Europe","status":"ACTIVE","expectedVersion":"1"}
```

A stale version returns `WORKSPACE_VERSION_CONFLICT` (409); reload before retrying.
Unrecognized fields are rejected. There is no blind merge or last-writer-wins fallback.
Response `version` values are strings; timestamps are ISO-8601; list returns
`workspaces` and `nextCursor`; other operations return `workspace`.
All responses use `Cache-Control: no-store`. Workspace responses include `traceId`
and `X-Workspace-Trace`; audit rows record the same trace UUID. No raw SQL, credentials,
creation key, or session values appear in error responses/logs. A commit failure returns
503, never a fabricated saved result. Retry creation with its original idempotency key.

## Explicit development migration and database privileges

After the existing bootstrap and core infrastructure steps:

```sh
node --env-file=.env scripts/init-workspaces.mjs --development
```

This applies only `003_workspaces.sql` to the configured local Compose database. It does
not run during API import/startup. Migration 001/002 must already exist; databases with
existing volumes need explicit reviewed 002 application before 003. No existing user,
site, collaborator or subscription row is reassigned. Back up and review production
migration deployment separately; the development helper refuses `NODE_ENV=production`.

The API must use a non-owner `NOSUPERUSER NOBYPASSRLS` database login. Workspace calls
fail with `UNSAFE_DATABASE_ROLE` (503) when the connection owns the workspace table,
is superuser or bypasses RLS, including the default Compose administrative login.
Use separate migration/admin credentials and configure the API's DATABASE_URL explicitly.
Never remove the check to make an elevated development connection work.

A DBA can adapt these grants to the already-provisioned runtime role; they are the
workspace increment's minimum grants, not a complete legacy application role definition:

```sql
GRANT USAGE ON SCHEMA public, platform TO forgestudio_api;
GRANT SELECT ON public.users, public.sessions, platform.tenants,
  platform.memberships, platform.workspaces TO forgestudio_api;
-- PostgreSQL row locking requires UPDATE privilege on at least one table column.
GRANT UPDATE (id) ON public.users, public.sessions, platform.tenants TO forgestudio_api;
GRANT UPDATE (version) ON platform.memberships TO forgestudio_api;
GRANT INSERT ON platform.workspaces, platform.audit_events TO forgestudio_api;
GRANT UPDATE (name, status, version, updated_at) ON platform.workspaces TO forgestudio_api;
-- Existing requireAuth also updates session activity.
GRANT UPDATE ("lastUsedAt") ON public.sessions TO forgestudio_api;
```

Do not grant UPDATE on workspace creation-receipt/identity columns or UPDATE/DELETE on
audit events. Do not reuse the migration role for the API. The new table's policies
require both transaction-local tenant/user scope and active membership; OWNER/ADMIN
is checked again for writes. The runtime role still needs separate reviewed grants
for legacy routes. These grants do not certify whole-application role separation.

## Verification and remaining boundaries

Pure policy tests are in `tests/foundation/session-policy.test.mjs` and
`tests/foundation/workspaces.test.mjs`; `npm run check` includes them. HTTP tests execute
the compiled route with an injected transaction, not a live Prisma database. Live
PostgreSQL tests execute the compiled core's actual SQL through `pg` in a newly-created
random disposable local database, including a non-owner runtime role. They cover
concurrent duplicate creates, stale updates, audit rollback, real RLS, connection
reuse, and the session revocation lock. They are not a full application browser E2E test.
The `workspace-api` CI job is non-informational, unlike the inherited legacy baseline.

Still required: provisioned account/tenant onboarding, workspace-to-site bindings and
reviewed legacy backfill, tenant-isolated legacy business routes, frontend integration,
plan/quota enforcement, complete authentication/CSRF audit, deployment grants, and
browser E2E. F01/F02/F04 remain in progress; no production deployment is claimed.

Security references: PostgreSQL 17 Row Security Policies and Explicit Locking;
OWASP Cross-Site Request Forgery Prevention Cheat Sheet (exact-origin/custom-header defense).
