# Owner-preserving website/workspace assignments

This increment extends PR #14's workspace chain. It is an organizational link,
NOT a migration of legacy website ownership into tenant-wide authorization.
`public.websites.userId`, editorData, collaborators, published state and existing
website/editor routes are unchanged. Tenant admins cannot see another owner's
site metadata through these endpoints. Only the current website owner can link
or unlink, and must also hold an active tenant OWNER/ADMIN membership.

## UI

Open Workspaces, select a tenant, then **My websites in this workspace** on a
workspace card. Choose one of your owned sites and select **Link website**.
The owned-site list is paginated and is NOT a guarantee that every site can be
linked: the server enforces one workspace link per website across all tenants.
Conflicting assignments return a generic message, never another tenant's IDs.
**Review unlink** / **Confirm unlink** removes only the selected association.
The original website continues to exist with unchanged editor access.

No automatic tenant, workspace, membership or site is provisioned. A platform
ADMIN/SUPER_ADMIN role is not a substitute for a tenant role or site ownership.
Workspace list counts and site list counts are not tenant-wide website totals.
Legacy collaborators retain their existing editor access but do not gain the
right to move or inspect the owner's organizational assignment.

## API

Canonical prefix: `/api/v1/tenancy/site-links`.
The existing `/api/tenancy/site-links` alias is retained by the tenancy mount.

| Method | Relative path | Result |
|---|---|---|
| GET | `/workspaces/:workspaceId?view=linked` | Current user's linked site metadata; no editorData or credentials. |
| GET | `/workspaces/:workspaceId?view=owned` | Current user's owned websites, irrespective of assignment eligibility. |
| PUT | `/workspaces/:workspaceId/sites/:siteId` | Link an owned website; an identical existing link is returned without another audit event. |
| DELETE | `/workspaces/:workspaceId/sites/:siteId` | Remove precisely the association identified by If-Match. Does not delete the website. |

GET supports `limit` (default 25, maximum 50) and UUID `after` cursor. Responses
contain `sites`, `nextCursor`, `success` and `traceId`. Linked rows have a `linkId`
and `linkedAt`; owned-list rows intentionally do not expose assignments in other
tenants. Names, slugs and status are existing metadata, not rendered HTML.

All calls require the existing session cookie and verified tenant selection.
Mutations require `Origin` matching the configured FRONTEND_URL, JSON `{}`, and
`X-ForgeStudio-Request: workspace-v1`. User/tenant/role fields in the body are
rejected. DELETE also requires `If-Match: "<current-link-uuid>"` (including quotes).
Missing preconditions return 428. A stale/missing/recreated association returns
412, preventing an old unlink request from deleting a newly-created link.

PUT returns 201 for a new link or 200 for the same existing link. This is a
resource-state operation, not the workspace creation API's historical receipt
protocol. There are no automatic mutation retries. After a timeout, refresh and
inspect current state before resubmitting. An unlink retry after confirmed
removal can return 412: inspect the list rather than assuming a server failure.
Closing/switching the panel aborts the browser request but does not cancel work
already received by the server. A move is an explicitly reviewed unlink followed
by a new link, not an atomic transfer. Competing assignments may win between them.

Archived workspaces reject new links. Existing links can still be listed and
removed. Missing site ownership returns a generic 404, regardless of existence.
Conflicting links return 409. Database failures return sanitized 503 responses,
not a success flag. Every response is no-store; no SQL or credentials are returned.

## Transaction and database protections

Operations reuse the workspace core's session, active-account, membership and
tenant checks within one transaction, including its row locks and timeouts.
Mutation lock order: session/user -> tenant/membership -> workspace -> website.
The website row lock serializes link/unlink and waits against ownership changes
or deletion. The workspace share lock prevents an in-flight attach from racing
an archive. Authorization changes that commit first deny subsequent operations;
an already-authorized operation may finish before a waiting revocation commits.

Links and their audit events commit together. Audit insertion failure rolls back
both attach and unlink. The global primary key on site_id prevents duplicate
assignments even when RLS hides the conflicting row. INSERT uses ON CONFLICT DO
NOTHING and returns a generic conflict instead of leaking constraint details.
RLS checks tenant scope, active membership, active account and current website
ownership. INSERT additionally checks manager role, creator identity and active
workspace. DELETE additionally checks manager role. No UPDATE policy exists.
Runtime credentials must not own/inherit ownership of site_links, be superuser,
or bypass RLS. Disabled/unenforced row security is also rejected by the service.

## Explicit migration / rollout

Use `infrastructure/postgres/004_site_links.sql` only AFTER reviewing and applying
the PR #14 lineage's platform versions 1/2/3 AND the legacy users/websites schema.
This file is not mounted in Compose init and is never run by API startup. It
creates an empty table; no existing websites are inferred into a tenant/workspace.
It deliberately refuses an already-used schema version 4. Do not delete a version
record or use database push to force it through. PR #11 has an independent schema
lineage and must be reconciled before a combined rollout.

Back up the database and review the migration on a disposable copy first. After
review, an operator may apply the file with a separate migration credential and
`psql -v ON_ERROR_STOP=1 -f infrastructure/postgres/004_site_links.sql` against the
explicitly selected database. This PR does not execute that production action.
A runtime role needs the existing WORKSPACES.md grants plus the following; these
are incremental grants, not a full-application security certification:

```sql
GRANT SELECT ON public.websites, platform.site_links TO forgestudio_api;
GRANT UPDATE (id) ON public.websites, platform.workspaces TO forgestudio_api;
GRANT INSERT, DELETE ON platform.site_links TO forgestudio_api;
```

Do not grant UPDATE on site_links or UPDATE/DELETE on audit_events. Do not reuse
the migration role for the API. Because links reference legacy sites, deleting a
website through the existing owner-authorized delete flow cascades its link;
prior audit events remain. Workspace deletion is restricted by the foreign key.

Rollback the application first if needed; keep the additive table and audit rows
for recovery. Do not drop populated association data as a routine code rollback.
No customer WordPress or payment action is triggered by this feature.

## Evidence and remaining work

33 standalone policy/transport tests run in the root foundation test glob.
`tests/integration/site-links.postgres.test.mjs` creates a random loopback DB,
uses a constrained role and executes the real compiled core and Express router
through pg. It tests transaction failure, concurrency, preconditions, RLS,
ownership, pagination, and HTTP errors. Session identity is injected only in the
test router; this is not full browser/requireAuth/Prisma E2E. Its minimal legacy
fixture does not certify the entire legacy migration history. New frontend
assignment interactions still require browser acceptance; existing workspace UI
browser regression remains inherited.

Remaining: integrate the parallel core-v1 control plane, establish one canonical
migration lineage, decide reviewed ownership transfer/shared workspace access,
apply tenant authorization to all legacy routes, full real-backend browser E2E,
quotas/billing integration and inherited dependency findings. No scale or
production readiness certification is implied by these tests.

Primary references: PostgreSQL 17 Row Security Policies
(https://www.postgresql.org/docs/17/ddl-rowsecurity.html) and Explicit Locking
(https://www.postgresql.org/docs/17/explicit-locking.html).
