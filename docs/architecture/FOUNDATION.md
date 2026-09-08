# Foundation ADRs and implementation boundary

Plan source: ForgeStudio Complete Project Plan, WordPress Architecture v2.0, dated 2026-09-09.
Baseline: `77b71509453cd5037ebe965008222ca193fe22d0`, tree `d9a446a79572661be4ad094522ec9dd43c092851`.

## ADR-001: Incremental foundation, not a rewrite
Retain frontend/backend and their independent dependency locks. Add pure, strictly typed contracts and
ports under packages and workers. Only request IDs, health probes, explicit migrations and shutdown
change legacy startup. New tenant/job tables are in a separate platform schema; existing websites are
NOT yet tenant-migrated. Module READMEs establish ownership, not completed features.

## ADR-002: Four distinct infrastructure roles
PostgreSQL owns tenancy, jobs, outbox destinations and consumer inboxes. Redis cache/control use separate
instances and eviction policies; limiter failures reject rather than silently grant. Kafka publishes events
with aggregate keys/acks=-1; acks are not proof that a downstream business transaction occurred.
RabbitMQ has five command queues and paired dead-letter queues, all quorum, mandatory publishing,
persistent messages, bounded in-flight work and confirm timeouts. A late ACK cannot complete a newer retry.

No mandatory global chain traverses both brokers for every request. `acceptJob` writes a job and two
independent delivery intents in the caller's tenant-scoped transaction. Broker SDK clients are injected
ports; they are not automatically connected to legacy handlers. Business consumers are disabled until
leases, reconcilers, due-time scheduling, authoritative permissions and real driver tests are wired.

## ADR-003: At-least-once with durable state, not an exactly-once slogan
Consumer ACK follows a committed outcome. External non-idempotent timeouts become OUTCOME_UNKNOWN.
The inbox insertion and local projection effect MUST use one database transaction. Query ordering,
lease ownership and replay retention are part of the implementation contract. A Redis lock is not a
publishing ownership fence. Rabbit returns are distinct from confirms; Kafka delivery is partition-ordered.

Remaining implementation details: concrete live connection management and worker stores, broker loss
reconciliation, stuck QUEUED/ACCEPTED jobs, delayed retry scheduler, cancellation/fencing, max-attempt
policy, consumer gap handling, protected backlog budget and transactional usage ledger. Do not enable
workers merely because the injected-port unit tests pass.

## ADR-004: WordPress read-only first
The original companion plugin grants a dedicated custom read capability, requires authenticated REST
permission checks and HTTPS outside the local fixture. It advertises UNPAIRED and write_sync=false.
No password vault, pairing, import or apply endpoint is implemented yet. WordPress remains on MariaDB;
SaaS state stays PostgreSQL. Native/headless publishing and Elementor compatibility require separate gates.

## ADR-005: Public sites independent from management
Future publishing workers create immutable artifacts and verified manifests; activation is fenced and
rollback selects an existing verified release. This foundation does not expose legacy draft APIs publicly
and does not pretend to have implemented the renderer or CDN. Existing published-site coupling remains F12.

## Reference documentation checked for this foundation
- RabbitMQ confirms/mandatory returns: https://www.rabbitmq.com/docs/confirms
- Quorum queues and dead-letter policy: https://www.rabbitmq.com/docs/quorum-queues
- Kafka Docker/KRaft quickstart: https://kafka.apache.org/quickstart/
- WordPress custom endpoints: https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/
- Compose dependency readiness: https://docs.docker.com/compose/how-tos/startup-order/

Image tags are development fixtures, NOT digest-certified production artifacts. TLS/ACLs, replication,
placement, provider quotas, image scanning/signing, support matrices, chaos tests and restore evidence
are required before production promotion. The full ten-billion workload envelope remains unproven.
