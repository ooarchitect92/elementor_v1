# Renderer workstream (F11)
No production renderer has been replaced. Start with a supported subset of the existing editor document.
Import the shared save/document boundary from `../site-schema/index.ts`; preserve unsupported source data.
Implement deterministic artifact manifests and a compatibility report before enabling publication.
Build workers must not run customer JavaScript, Composer or PHP inside the API process.
Required tests: supported layout round-trip, missing assets, unsupported widgets, deterministic build,
failed build leaves active release intact, stale worker cannot activate, rollback uses prior artifacts.
