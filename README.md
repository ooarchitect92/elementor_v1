# ForgeStudio

Visual website-builder SaaS with a WordPress-first platform foundation.

**Current milestone: team foundation 0.1, not the completed v2 product.** Existing editor and application
routes are retained. Shared contracts, development infrastructure, permission boundaries, migrations,
broker adapter ports and a read-only WordPress plugin are ready for parallel engineering.
Production traffic, real WordPress content, billing and public publishing are not migrated by this change.

## First checkout

Use Node.js 22 (22.16 or newer within that line), npm, Docker Engine/Desktop with Compose v2, and PHP 8.1+
for plugin unit checks. Windows users can run these commands in PowerShell; Docker Desktop must be running.

```sh
npm run bootstrap
npm ci
npm run check
php tests/foundation/wordpress.test.php
npm run infra:up
npm run infra:init
npm run infra:smoke
```

`bootstrap` does not overwrite existing credentials. It creates ignored local `.env` files. The default
stack runs PostgreSQL, separate cache/control Redis instances, and RabbitMQ. All published ports bind
127.0.0.1. Normal shutdown is `npm run infra:down`; **do not add `-v` unless intentionally destroying local data**.

For Kafka and the disposable WordPress/MariaDB test site:

```sh
npm run infra:full
npm run infra:init -- --kafka
```

WordPress is at `http://localhost:8081`. Finish its installer and activate ForgeStudio Connect.
No admin account, application password, SaaS pairing or customer migration is created automatically.
RabbitMQ's local console is `http://localhost:15672`; credentials are in your ignored `.env`.

## Existing application

Legacy dependency/build certification is a separate F01 task. Root `npm ci` installs the foundation
compiler only, not every frontend/backend dependency. Configure `backend/.env` from its example and
`frontend/.env` from its example, then install in each directory. Never copy a production secret here.

```sh
npm --prefix backend ci
npm --prefix backend run db:generate
npm --prefix backend run build
npm --prefix frontend ci
npm --prefix frontend run build
```

Apply reviewed legacy migrations explicitly to a development database. API imports no longer repair
schema automatically. Then use `npm run dev:backend` and `npm run dev:frontend` in separate terminals.
The optional `legacy-app` Compose profile supplies Docker build recipes; it is **not certified by the
foundation tests**. Container DATABASE_URL must use host `postgres`, not `localhost`. OAuth/email values
remain environment-specific. The legacy snippet scheduler is off unless explicitly enabled in development.

## Team entry points

| Workstream | Start here |
| --- | --- |
| Backend / tenancy | `backend/src/modules/`, `packages/platform/authorization.ts`, `infrastructure/postgres/` |
| Editor / revisions | `packages/site-schema/`, `packages/renderer/`, existing `frontend/src/pages/editor/` |
| Messaging / workers | `packages/platform/{redis,kafka,rabbitmq}.ts`, `workers/shared/` |
| WordPress / PHP | `wordpress-plugin/forgestudio-connect/` |
| Platform / QA | `compose.yaml`, `infrastructure/`, `tests/`, `.github/workflows/` |

Read [team handoff](docs/team/START_HERE.md), [architecture decisions](docs/architecture/FOUNDATION.md),
[remaining work](docs/team/WORK_PACKAGES.md), and [verification evidence](docs/release-evidence/FOUNDATION.md).
Run `npm run status` for the work-package registry and `npm run inventory` for a reproducible source inventory.

Redis accelerates disposable data; PostgreSQL owns business state. RabbitMQ dispatches commands; Kafka
carries independently replayable events. Docker packages these components; single-host Compose is not HA.
No ten-billion-user, all-plugin compatibility, real lead delivery, or end-to-end production claim is made.
