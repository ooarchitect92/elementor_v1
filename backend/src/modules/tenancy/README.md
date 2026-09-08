# Tenancy module boundary

F02: map legacy identities/sites to verified tenant memberships; enforce every read/write and test RLS with a nonprivileged role.

This boundary is reserved, not a registered production API. Reuse existing authentication and UI;
follow `docs/team/START_HERE.md` and add OpenAPI/permission/failure tests before mounting routes.
