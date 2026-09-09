# F02/F04 workspace access increment

Base: PR #10, `3e19019b158a819c827c9a2981b5d3c745440a46`.
Status: implemented increment, not closure of F01/F02/F04 or production certification.

## Changes

- Existing `requireAuth` now rejects inactive/missing users and malformed/oversized
  cookie tokens before granting request authority; revocation/expiry remain enforced.
- Actual list/read/create/update/archive workspace HTTP endpoints on the existing
  tenancy router, preserving existing frontend and legacy routes.
- Fresh, transaction-locked session/account/membership/tenant checks, OWNER/ADMIN
  writes, non-owner/NOBYPASSRLS credential guard, transaction-local context and timeouts.
- Additive v3 workspace table with RLS requiring active membership and tenant context;
  immutable creation receipts under the documented runtime grants; no hard deletion.
- Concurrent create idempotency, stale-version conflicts, transaction-coupled audit
  rows, safe error responses and CSRF checks on new mutation routes.
- Explicit development migration helper, API/runbook and a non-informational CI job
  building the actual backend and running HTTP plus disposable PostgreSQL checks.

## Local evidence

- Node.js 22.16.0: 81 new unit tests passed, 0 failed/skipped.
- TypeScript strict standalone checking passed for workspace core and session policy
  with noUncheckedIndexedAccess and exactOptionalPropertyTypes.
- HTTP and live PG test files pass JavaScript syntax checks locally.
- Container has no Docker/psql or network package access. Full backend compile, HTTP,
  and actual PostgreSQL results must be read from the new CI job; source-only/fake-SQL
  tests are not reported as proof of live RLS, broker behavior or full application E2E.

## Before merge / deployment

Check `workspace-api`, contracts and infrastructure jobs on the PR's exact commit.
Review database grants, origin configuration and explicit migration application. Keep
production untouched until deployment review. Apply 002 before 003 to older volumes;
003 does not automatically backfill sites, create memberships or provision a login.

Read `docs/api/WORKSPACES.md` for behavior, examples, permissions and remaining work.
