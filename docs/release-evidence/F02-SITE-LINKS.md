# F02 owner-preserving site-link increment

Base: PR #14, `1f1d4162e066f977b1c7286d02e91ecdc8a8ac1c`.
Status: implementation increment; F01/F02/F04 remain IN PROGRESS.

Implemented: mounted list/owned-site/attach/exact-unlink API, additive forced-RLS
association schema, transactional ownership/membership checks, atomic audits,
workspace-card integration, explicit assignment conflict/reload handling.
Existing site ownership/editorData/collaborators/publishing are not migrated.

Local task-container evidence (Node 22.16.0):
- `node --experimental-strip-types --test tests/foundation/site-links.test.mjs`:
  33 passed, 0 failed, 0 skipped.
- Strict TypeScript standalone noEmit checks on site-links.policy.ts and
  site-links-client.ts, with noUncheckedIndexedAccess/exactOptionalPropertyTypes:
  passed.
- `node --check tests/integration/site-links.postgres.test.mjs`: passed.
- Reconstructed original WorkspacePanel.tsx bytes matched Git blob
  `e01bc519e33c6154d5bf4ce02a7a8c17d5b581a8` before a small additive UI patch.

The container cannot resolve GitHub/npm and has no Docker/PostgreSQL tooling.
Full backend/frontend compilation and new live HTTP/PostgreSQL checks must run in
CI; results are not pre-claimed here. CI evidence for the exact commit is recorded
in the PR after inspection. Existing workspace browser regressions are inherited;
new assignment UI interactions are not represented as browser-tested here.

New CI workflow is independent of the concurrently modified core-v1 workflow.
No main/shared branch update, merge, production migration, inferred tenant/site
backfill, credential creation, charge or customer WordPress action was performed.
See docs/api/SITE_LINKS.md for API, preconditions, runtime grants, migration-lineage
checks, retry/rollback semantics and remaining limitations.
