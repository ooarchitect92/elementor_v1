# Tenant-scoped outbox relay

`main.ts` is the production runtime entrypoint for the durable PostgreSQL outbox.

It runs three supervised loops:

1. RabbitMQ command relay using mandatory persistent messages and publisher confirms.
2. Kafka event relay using an idempotent producer, `acks=-1`, and pre-created topics.
3. Expired job-lease recovery.

The worker **requires** `WORKER_TENANT_IDS`. It does not bypass PostgreSQL row-level
security or scan every tenant globally. A cell scheduler should assign a bounded tenant
partition to each process. Multiple processes may safely overlap because claims use
`FOR UPDATE SKIP LOCKED` and every completion is fenced by a lease token.

Start locally after the infrastructure has been initialized:

```bash
npm run bootstrap
docker compose --profile analytics up -d --wait postgres redis-cache redis-control rabbitmq kafka
npm run infra:init -- --kafka
# Set one or more tenant UUIDs in .env, then:
npm run worker:outbox
```

This runtime relays and recovers durable work. It does not enable any domain queue
handler. Domain adapters must be registered separately through
`workers/shared/rabbit-worker.ts` after provider-specific integration evidence exists.
