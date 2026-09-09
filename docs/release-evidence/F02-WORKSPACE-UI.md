# F02 workspace frontend increment

Base: `091adbf5356da490feaa8590998e9c1855da6ce8`, PR #12 (`feat/F02-workspace-security`).
Status: implemented increment; F01/F02/F04 remain IN PROGRESS.

## Implemented

- Shared workspace panel in the existing user dashboard and authenticated `/workspaces` route; links from Admin/Super Admin dashboards.
- Explicit tenant selection, current membership display, bounded list pagination and loaded-page status filters.
- Tenant OWNER/ADMIN create/rename/archive/restore UI calling the existing workspace endpoints. Platform roles do not grant tenant permission.
- Original idempotency-key recovery in user/tenant-scoped tab storage; explicit uncertain outcome, retry and discard flows.
- String-version conditional updates; conflict draft preservation and explicit discard/reload rather than automatic overwrite.
- Aborted/late-response fencing across tenant changes and session expiry; fail-closed response shape, user and tenant validation; safe error text and support trace.
- Separate strict TypeScript/unit/frontend-build/browser CI gate. No dependency or lockfile changes.

## Local execution

Executed in the task container with Node v22.16.0 and TypeScript 5.8.3:

- `node scripts/check-workspace-ui.mjs`: PASS, **44 tests, 0 failed, 0 skipped**; strict client/controller compilation included.
- `node --check tests/browser/workspaces.browser.test.mjs`: PASS.
- Existing App/dashboard source reconstructed from connector reads and verified byte-for-byte against their base Git blob SHAs before applying only additive navigation changes.

This container has no available dependency network, installed React bundle, Chrome or Docker. Full frontend build and the eight authored browser scenarios are **not represented as locally executed**. Exact pushed-commit CI results must be attached to the pull request after execution; this file does not pre-claim those results.

Browser checks use a real built React app and Chrome, but a loopback API fixture. They are not whole-application/database E2E. Existing backend and PostgreSQL regression jobs remain inherited from PR #12.

## Safety / remaining work

No main/shared branch update, merge, production migration/deployment, automatic tenant provisioning, website reassignment, payment, customer WordPress action or API authority change. Workspace UI requires the provisioned membership/schema/runtime grants described in `docs/api/WORKSPACES.md`.

PR #11 is advancing independently. No core-v1 files are overwritten or incorporated here; later integration must reconcile backend schema, authentication and CI deliberately. This increment does not resolve inherited dependency findings (#13), site/workspace binding, tenant onboarding, plan enforcement or browser-to-real-backend E2E. Local recovery is tab-scoped request metadata, not a durability/capacity guarantee.
