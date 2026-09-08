# Infrastructure composition boundary
Inject real clients into the tested ports under `packages/platform/` and `workers/shared/`.
Do not open Redis/Kafka/RabbitMQ connections as module-import side effects. Use bounded timeouts,
TLS/ACLs, redacted errors, one process shutdown owner and separate cache/control Redis clients.

This foundation does not install unverified additional driver versions into the legacy app. F05/F07/F08
own exact SDK versions, committed locks, real service tests and connection lifecycle before consumers
are enabled. amqplib adapter publication bodies must convert Uint8Array to Buffer and forward return,
confirm, close, error and drain events. Kafka client setup must honor KAFKA_PRODUCER_POLICY.
