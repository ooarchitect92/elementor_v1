# Workspace management UI

## Entry points

- Existing user dashboard: **Workspaces** in General navigation, `/dashboard?tab=workspaces`.
- Shared authenticated page: `/workspaces`. Admin and Super Admin dashboards link here.
- All entry points reuse `frontend/src/features/workspaces/WorkspacePanel.tsx` and the existing authentication context. A platform ADMIN/SUPER_ADMIN role does not grant tenant OWNER/ADMIN privileges.

This screen manages workspace records only. It does not assign websites, change legacy team collaboration, create tenants, provision memberships, enable billing/quotas, or incorporate the parallel core-v1 branch.

## Required backend setup

Use the workspace-security backend from PR #12 or its subsequently reviewed integration. See `docs/api/WORKSPACES.md` for the exact API contract, explicit schema-v3 migration and runtime grants. Existing installations must have migrations 001/002/003 applied through the reviewed deployment procedure. API startup does not apply them.

An active session, ACTIVE account, ACTIVE tenant and deliberately provisioned ACTIVE membership are required. An account with no tenants sees a provisioning explanation, not a fabricated workspace. The workspace backend requires a non-owner, NOSUPERUSER, NOBYPASSRLS runtime database role. Default administrative Compose credentials are intentionally rejected.

Set `VITE_API_URL` to the API origin when building the frontend. Set backend `FRONTEND_URL` to the exact frontend origin; production requires HTTPS. Do not add an origin-bypass switch to make a test pass. Browser mutations send cookies, JSON, `X-ForgeStudio-Request: workspace-v1`, an explicit tenant selector, and (for create) a UUID `Idempotency-Key`. The browser supplies Origin automatically. Nothing in browser storage or these headers substitutes for backend authorization.

## User workflow

One active tenant is selected automatically. Multiple tenants require an explicit selection. Refresh memberships revalidates available tenants and roles. Changing tenant clears previous workspace rows and edit state immediately; aborted or late responses cannot repopulate them.

OWNER/ADMIN members can create, rename, archive and restore. Other tenant roles can list/filter workspaces. Pagination and counts describe loaded rows, not an invented global total. Slugs are immutable and remain reserved after archive. Archive does not delete websites or unpublish content.

Creation requires a name of 1–120 printable characters and a slug of at most 63 lowercase alphanumeric characters with internal hyphens. Updates submit the original edit snapshot's decimal-string version. No success indicator appears before a verified server acknowledgement. After creation (including receipt replay), the UI reloads current state instead of inserting the original creation snapshot as if it were current.

## Interrupted requests and conflict recovery

Before the first create POST, the UI stores the normalized name/slug and original request UUID in this tab's sessionStorage, scoped by authenticated user UUID and tenant UUID. No session token, role, credential or personal contact data is stored. Workspace names may themselves be sensitive: storage remains readable to same-origin code. This is local request metadata, not durable server data or a backup.

If storage is unavailable, creation is refused before the POST. If a request times out, is interrupted, returns a server error, or has an unverifiable success payload, its outcome is shown as uncertain. **Retry original request** uses the same key/body, including after a page reload. It does not automatically issue retries. An original receipt may represent a workspace that was subsequently renamed or archived; the current list is read again.

Recovery lasts only as long as the browser tab's sessionStorage. Closing the tab, clearing browser data, changing origins or losing the device can remove it. Before starting another create after such a loss, inspect server state; the slug remains uniquely reserved. On logout, scoped records are not automatically erased because erasure could lose an uncertain operation's key; they are not shown to another user and cannot authorize requests. Review this retention with the deployment's privacy policy.

Discard recovery requires an explicit confirmation and removes only local metadata. It does **not** cancel an accepted request or delete a server workspace. Corrupt recovery is reported rather than silently replaced. No automatic tenant/site migration occurs.

For a version conflict or uncertain PATCH, the typed draft remains visible and another save is blocked. Copy any desired text, choose **Discard draft and reload**, and review the latest version before editing again. The UI does not blindly merge a stale draft or reapply it to a new version. Unsaved edit text is not persisted across reloads; only pending creation metadata has reload recovery.

## Verification

`node scripts/check-workspace-ui.mjs` compiles the independent client/controller with strict TypeScript and runs 44 native Node tests. Root `npm ci` is required first. The committed frontend build remains `npm --prefix frontend run build`.

`tests/browser/workspaces.browser.test.mjs` runs the built React app in installed Chrome through CDP against a loopback API fixture. CI builds with `VITE_API_URL=http://127.0.0.1:5055` and runs it with `WORKSPACE_BROWSER_TEST=1`. Missing browser or build fails the gate; it is not silently skipped. No additional test dependency is installed or committed. The browser fixture tests UI behavior and contract handling, **not a real Prisma/session/database pipeline**. The inherited workspace-api gate separately tests HTTP routing and real PostgreSQL core SQL.

The independent `.github/workflows/workspace-ui.yml` keeps frontend build and browser checks non-informational without editing the overlapping core-v1 workflow. Full browser-to-real-backend tests, website binding, onboarding, quotas and the inherited dependency-security review remain open.
