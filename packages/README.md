# Shared contracts and ports
`npm run build:foundation` emits ESM JavaScript and declarations to `.foundation/build/`.
`npm test` uses Node 22's TypeScript stripping for source-level tests; `npm run typecheck` is a separate
strict compiler gate. Do not mistake type stripping for type checking.

Source modules use explicit `.ts` relative imports. The build rewrites them to `.js`. Domain teams
must either consume the emitted artifacts or add reviewed package exports/build wiring; do not import
source files outside `backend/tsconfig.json`'s rootDir and assume the legacy build can emit them.
The legacy frontend/backend package locks are intentionally independent. No root workspace rewrite
or blanket dependency upgrade is part of this foundation.

Contracts: events/tasks, lossless editor-save envelope, tenant permissions, job states, adapter outcomes.
Ports: Redis, Kafka, RabbitMQ, SQL transaction and outbox/worker boundaries. Driver connections are
injected and must have timeouts/TLS/ACLs, shutdown handlers and live integration tests before enabling
consumers. There is no hidden connection to a production broker.
