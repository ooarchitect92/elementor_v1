# Local stack and recovery guardrails

Start: bootstrap -> root npm ci/check -> infra:up -> infra:init -> infra:smoke.
Full fixtures: infra:full -> infra:init -- --kafka. Application profile is separate and requires actual
legacy build fixes/configuration and explicitly reviewed migrations. No SaaS or WP admin is seeded.

If a port is occupied, change the relevant local port in `.env` and recreate only the affected service.
Use `docker compose logs <service>`; redact credentials/customer content before sharing logs.
`docker compose down` preserves named volumes. `down -v` destroys them and is never a recovery procedure.
Changing POSTGRES_PASSWORD after initialization does not automatically rotate the database role password.
A recreated container is not proof that its durable volume or business records were restored.

Kafka fixture uses replication factor/min ISR 1; RabbitMQ quorum queues have only one local member.
Production requires multi-zone placement, tested replica/quorum counts and capacity for failures. Local
PLAINTEXT listeners and generated .env credentials are not a production security policy.

Before enabling consumers: implement an authoritative stuck-job scanner for ACCEPTED, QUEUED and
expired RUNNING jobs; persisted due-time retries; max-attempt/retention budgets; independent outbox
replay; inbox transactional effects; destination rate limits; and OUTCOME_UNKNOWN reconciliation.
Simulate DB commit/response loss, confirm/record loss, job commit/ACK loss and external write/response
loss. Use stable job/event IDs plus new lease tokens; never use broker queue deletion as reconciliation.

Back up PostgreSQL and object artifacts independently of replicas. Record PITR retention, restore
procedure, measured RPO/RTO, separate recovery credentials and deletion/suppression behavior. This
foundation ships no production backup operator, Terraform apply or failover automation.
