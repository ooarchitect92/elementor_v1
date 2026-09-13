# Messaging and publish runtime

## Responsibilities

- PostgreSQL is the source of truth for jobs, leases, results, outbox records and immutable release metadata.
- RabbitMQ carries bounded commands. A command is acknowledged only after the worker commits the durable job outcome.
- Kafka receives replayable business events; it is not placed in the synchronous editor-save path.
- Redis remains a cache/control-plane dependency and never becomes the sole copy of saved customer work.

## Publish lifecycle

1. `POST /api/v2/websites/{websiteId}/publish-jobs` authenticates the user, verifies owner/admin permission and requires an idempotency key.
2. One database transaction provisions the tenant boundary, persists the job resource, command and business event.
3. The outbox worker confirms the RabbitMQ command and Kafka event before marking either delivery sent.
4. The publish worker fences the job with a lease, reads the immutable requested revision, creates one release and activates it transactionally.
5. The job becomes `SUCCEEDED` only after the release transaction commits. Retries are idempotent through the job-specific release request key.
6. Public delivery continues to read only the active release through `/api/v2/public/sites/{websiteId}`.

## Local verification

```bash
npm run bootstrap
npm ci
npm run check
docker compose --profile analytics up -d --wait postgres redis-cache redis-control rabbitmq kafka
npm run infra:init -- --kafka
npm run runtime:smoke
npm run publish:smoke
```

The smoke tests use disposable fixtures. They are not a production load, failover or multi-region certification.

## Recovery rules

- Idempotent publish jobs with expired leases are retried within their attempt/deadline budget.
- Non-idempotent integrations become `OUTCOME_UNKNOWN` after an uncertain remote side effect and require reconciliation.
- RabbitMQ/Kafka acknowledgement is not treated as a website release. Only the committed active release is public.
- Never delete pending outbox records to unblock a deployment. Diagnose, repair the destination and replay them.
