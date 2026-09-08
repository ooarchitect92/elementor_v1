# Media worker boundary

Work packages: F05/F11. No consumer is enabled by this directory.
Implement a registered adapter against `../shared/worker.ts` only after its SQL lease/outcome store,
due-time scheduler, fencing, broker recovery and integration tests exist. Do not fake successful work.
Apply separate resource budgets and keep untrusted code outside the API process.
