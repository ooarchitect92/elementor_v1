# Messaging runtime operations

## Scope

This runbook covers the tenant-scoped PostgreSQL outbox, RabbitMQ command relay,
Kafka event relay, job fencing, retry scheduling, and expired-lease recovery.

## Local verification

```bash
npm run bootstrap
docker compose --profile analytics up -d --wait postgres redis-cache redis-control rabbitmq kafka
npm run infra:init -- --kafka
npm run infra:smoke -- --kafka
npm run runtime:smoke
```

The runtime smoke test uses the real locked Node.js clients. It verifies:

- Redis cache writes and fail-closed control-plane rate limiting;
- PostgreSQL tenant RLS and idempotent job acceptance;
- RabbitMQ mandatory persistent publication with broker confirmation;
- a real RabbitMQ consumer that acknowledges only after the fenced outcome commit;
- a retry that creates a new delayed outbox delivery and then succeeds;
- Kafka publication to pre-created topics with all-replica acknowledgements;
- an expired non-idempotent lease becoming `OUTCOME_UNKNOWN`.

The test owns fixed fixture UUIDs and removes their rows at start and finish. CI destroys
all disposable container volumes afterward.

## Worker launch

Set a bounded comma-separated assignment:

```dotenv
WORKER_TENANT_IDS=11111111-1111-4111-8111-111111111111
```

Then run:

```bash
npm run worker:outbox
```

The assignment is explicit by design. The runtime does not use a cross-tenant RLS bypass.
A production cell scheduler should shard tenant assignments and restart failed processes.

## Delivery truth table

| Situation | Durable result |
|---|---|
| RabbitMQ confirms publication | Outbox destination becomes `SENT` |
| RabbitMQ/Kafka publication is unconfirmed | Outbox delivery is retried with bounded jitter |
| Outbox retry budget is exhausted | Delivery becomes `FAILED`; an unqueued command job fails permanently |
| Adapter returns delivered receipt | Job becomes `SUCCEEDED` before broker ACK |
| Idempotent adapter fails or lease expires | A new delayed command outbox record is created |
| Non-idempotent lease expires after possible side effect | Job becomes `OUTCOME_UNKNOWN`; no blind replay |
| Completion uses a stale fencing token | Completion is rejected and the message is not ACKed |

## Production rollout gates

Do not enable a domain queue until all of the following exist:

1. A tested adapter with an explicit side-effect classification.
2. Provider idempotency or reconciliation evidence.
3. Queue-specific timeout, retry, and permanent-failure mapping.
4. Metrics for due age, lease age, retry count, dead letters, and unknown outcomes.
5. A runbook for replay and manual reconciliation.
6. Capacity tests using the intended broker and database topology.

The Docker services in this repository are development/CI fixtures, not a production
high-availability deployment.
