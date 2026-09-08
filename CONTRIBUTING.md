# Contributing

Create work branches from the accepted foundation branch (or main after it merges):
`feat/F02-tenant-membership`, `feat/F03-server-revisions`, `feat/F09-wordpress-pairing`.
Do not have every team member push directly to main or the shared foundation branch.

Before work: read your work package, inspect existing routes/schema, agree on shared contract changes.
Before PR: run foundation checks, applicable app build/tests, and integration checks for changed adapters.
Describe UI -> API -> authorization -> persistence -> failure -> telemetry -> tests. Include migrations,
rollback/forward repair and compatibility impact. Mark missing behavior honestly.

The root foundation compiler is pinned and locked separately from the original app. Keep lock files
committed. No database or broker need be running for unit checks. Integration tests use disposable local
volumes and generated credentials. Never run the test SQL against a customer database.

Changes under shared contracts, database schema or worker semantics need a platform/backend review.
WordPress changes need a WP/PHP reviewer. CODEOWNERS currently routes reviews to the repository owner
until actual team handles are supplied; it does not itself enforce branch protection.
