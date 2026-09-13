# Redis application runtime

ForgeStudio uses two deliberately separate Redis roles:

- `redis-cache`: evictable positive authentication cache. PostgreSQL remains authoritative.
- `redis-control`: non-evicting activity claims and distributed public-form rate limits.

## Authentication behavior

The API caches only validated, active, non-revoked sessions for at most 60 seconds; the default is 15 seconds and never exceeds the session expiry. Password hashes and raw tokens are never cached. Logout and bulk session revocation delete the positive cache entry immediately. When cache Redis is unavailable, authentication reads PostgreSQL.

Session activity writes are globally coalesced with a control-plane `SET NX EX` claim. If control Redis is unavailable, the existing conditional PostgreSQL update remains the fallback.

## Public form behavior

Public form throttling is server-controlled. The client cannot disable honeypot checks or raise the rate limit. Production fails closed when the Redis control plane is unavailable. Development can use a bounded in-process fallback.

The server loads the form definition from the active immutable release, validates submitted field names/types/options, and derives success/redirect/popup behavior from that trusted release. Client-provided webhook/email destinations are ignored. External delivery remains `NOT_CONFIGURED` until its durable worker and reconciliation evidence are implemented.

## Local verification

```bash
npm run bootstrap
npm ci
docker compose up -d --wait postgres redis-cache redis-control rabbitmq
npm run backend-redis:smoke
```

## Production requirements

Use managed Redis with TLS/authentication, separate cache/control clusters or strongly isolated logical deployments, bounded connection timeouts, monitoring for control-plane unavailability, and a secret manager for credentials. Do not store sole copies of sessions, submissions, releases, or jobs in Redis.
