# Full v2 implementation work packages

All 36 approved-plan IDs are retained. `foundation_started` is partial implementation, not completion.

| ID | Priority | Status | Deliverable |
| --- | --- | --- | --- |
| F01 | P0 | foundation_started | Reproducible build, route/schema inventory and feature truth audit |
| F02 | P0 | foundation_started | Tenant/membership model and scoped authorization |
| F03 | P0 | planned | Save contract, server revisions and conflict handling |
| F04 | P0 | foundation_started | Origin isolation, SSRF and secret-management foundation |
| F05 | P0 | foundation_started | Docker images and local/full integration environments |
| F06 | P0 | foundation_started | Durable jobs, outbox, inbox and idempotency contracts |
| F07 | P0 | foundation_started | RabbitMQ quorum dispatch and recovery scheduler |
| F08 | P0 | foundation_started | Redis cache/session/limiter implementation |
| F09 | P1 | foundation_started | WordPress plugin pairing and capability manifest |
| F10 | P1 | planned | Core WordPress content import into drafts |
| F11 | P1 | planned | Pilot templates and controlled publish compiler |
| F12 | P1 | planned | Independent edge delivery and domain workflow |
| P01 | P1 | planned | Native WP apply endpoint, mappings and conflict UI |
| P02 | P1 | planned | Release approvals, evidence packet and rollback |
| P03 | P1 | planned | Lead persistence and delivery ledger |
| P04 | P1 | planned | One CRM + email + signed webhooks |
| P05 | P1 | foundation_started | Kafka topics, registry, relays and projections |
| P06 | P1 | planned | Tenant subscription, usage ledger and quotas |
| P07 | P1 | planned | Client review portal and scoped agency access |
| P08 | P1 | planned | Supported portable package and clean re-import |
| P09 | P1 | planned | WordPress compatibility/migration test corpus |
| P10 | P1 | planned | Operations center, alerts and business synthetics |
| P11 | P1 | planned | Security review, restore drill and paid-pilot gate |
| P12 | P1 | planned | Design-partner onboarding and paid validation |
| G01 | P2 | planned | Selected Gutenberg / Elementor adapters |
| G02 | P2 | planned | CMS localization and content dependencies |
| G03 | P2 | planned | Agency fleet blueprints and canary rollouts |
| G04 | P2 | planned | White-label portal and reseller operations |
| G05 | P2 | planned | WooCommerce adapter and native checkout path |
| G06 | P2 | planned | AI proposals and consent-aware analytics |
| G07 | P2 | planned | Curated SDK / adapter marketplace |
| G08 | P2 | planned | Optional managed WordPress hosting |
| S01 | P3 | planned | Multi-cell placement and tenant migration |
| S02 | P3 | planned | Multi-region recovery and delivery options |
| S03 | P3 | planned | Enterprise identity and dedicated capacity |
| S04 | P3 | planned | Ten-billion-envelope capacity certification |

See `work-packages.json` for dependencies, responsible functions and acceptance evidence.
The initial engineering issues group related workstreams; implementation branches should still name the specific ID.
