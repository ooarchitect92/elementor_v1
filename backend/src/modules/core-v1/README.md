# Core v1 runtime

This module is the first production-path integration built on the team foundation.

## Guarantees
- Draft/editor state remains authenticated.
- Saves use `expectedRevision` optimistic concurrency and a 16-128 character `requestKey`.
- A repeated request key with the same payload returns the original durable receipt; reuse with a different payload fails.
- Every acknowledged save has a server-side revision row.
- Content-only collaborators cannot submit design mutations through the v2 endpoint.
- Publishing snapshots only the selected persisted current revision and creates an immutable release payload.
- Public reads can only see the single explicitly ACTIVE release, never draft editor data.
- Activation of an older release provides rollback without rebuilding it.

## Required migration
Apply `backend/prisma/manual/003_core_v1.sql` through the reviewed migration process before enabling these routes in an environment.

## API
- `GET /api/v2/websites/:websiteId/editor-state`
- `PUT /api/v2/websites/:websiteId/editor-state`
- `GET /api/v2/websites/:websiteId/revisions`
- `GET /api/v2/websites/:websiteId/revisions/:revision`
- `POST /api/v2/websites/:websiteId/publish`
- `GET /api/v2/websites/:websiteId/releases`
- `POST /api/v2/websites/:websiteId/releases/:releaseId/activate`
- `GET /api/v2/public/sites/:websiteId` (public, published-only)

The current publish operation creates a verified database snapshot synchronously. Moving compilation/artifact generation behind the durable RabbitMQ job path remains F11; this endpoint's release/idempotency contract is intentionally compatible with that next step.
