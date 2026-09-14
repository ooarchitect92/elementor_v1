import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { LocalObjectStore, sha256 } from "../../packages/platform/object-store.ts";
import { compileIncrementalRelease, publishCompiledRelease } from "../../packages/renderer/incremental-compiler.ts";
import { chooseCell, initialPlacement, startMigration, advanceMigration, assertWriteFence } from "../../packages/platform/cell-routing.ts";
import { MetricsRegistry, structuredLog } from "../../packages/platform/observability.ts";
import { buildCompatibilityPassport, contentFingerprint, decideWordPressSync } from "../../packages/wordpress/compatibility.ts";
import { inspectMedia, advanceMediaState } from "../../packages/media/pipeline.ts";
import { classifyDelivery, deliveryEnvelope, nextDeliveryState, retryDelayMs, validateTrustedDestination, webhookHeaders } from "../../packages/integrations/delivery.ts";
import { aggregateUsage, decideUsage, tieredAmountMinor } from "../../packages/billing/ledger.ts";
import { createBackupManifest, verifyBackupManifest, verifyRestoreEvidence } from "../../packages/platform/recovery.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SITE = "22222222-2222-4222-8222-222222222222";
const RELEASE = "33333333-3333-4333-8333-333333333333";

test("local object storage writes atomically and verifies checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "fs-object-store-"));
  try {
    const store = new LocalObjectStore(root);
    const body = Buffer.from("durable artifact");
    const stored = await store.put({ key: "tenants/a/site.json", body, contentType: "application/json", expectedSha256: sha256(body), ifNoneMatch: true });
    assert.equal(stored.sha256, sha256(body));
    assert.deepEqual(Buffer.from((await store.get("tenants/a/site.json")).body), body);
    await assert.rejects(() => store.put({ key: "tenants/a/site.json", body, contentType: "application/json", ifNoneMatch: true }), /OBJECT_ALREADY_EXISTS/);
    await store.delete("tenants/a/site.json");
    assert.equal(await store.head("tenants/a/site.json"), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incremental compiler reuses unchanged content-addressed artifacts and activates last", async () => {
  const root = await mkdtemp(join(tmpdir(), "fs-compiler-"));
  try {
    const payload = {
      website: { id: SITE, name: "Test", slug: "test", status: "PUBLISHED" },
      editorData: { pages: [
        { id: "home", name: "Home", slug: "/", elements: [{ id: "h", type: "heading", content: "Hello" }] },
        { id: "about", name: "About", slug: "about", elements: [{ id: "p", type: "text", content: "About" }] },
      ] }, customCodeSnippets: [], themeLocationRules: [],
    };
    const first = compileIncrementalRelease({ tenantId: TENANT, websiteId: SITE, releaseId: RELEASE, sourceRevision: 4, rendererVersion: "2.0.0", payload, generatedAt: "2026-09-14T00:00:00.000Z" });
    assert.equal(first.changed.length, 2);
    const store = new LocalObjectStore(root);
    await publishCompiledRelease(store, first);
    assert.ok(await store.head(first.activePointerKey));

    const second = compileIncrementalRelease({ tenantId: TENANT, websiteId: SITE, releaseId: "44444444-4444-4444-8444-444444444444", sourceRevision: 5, rendererVersion: "2.0.0", payload, previousManifest: first.manifest, generatedAt: "2026-09-14T00:01:00.000Z" });
    assert.equal(second.changed.length, 0);
    assert.deepEqual(second.unchanged.sort(), ["index.json", "pages/about.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cell routing is deterministic and migration rotates the write fence", () => {
  const cells = [
    { id: "blr-a", region: "ap-south-1", status: "ACTIVE", capacityUnits: 100, allocatedUnits: 20, generation: 1 },
    { id: "blr-b", region: "ap-south-1", status: "ACTIVE", capacityUnits: 100, allocatedUnits: 10, generation: 1 },
  ];
  assert.equal(chooseCell(TENANT, cells).id, chooseCell(TENANT, [...cells].reverse()).id);
  const placement = initialPlacement(TENANT, cells);
  assert.doesNotThrow(() => assertWriteFence(placement, placement.cellId, placement.epoch, placement.fenceToken));
  const target = cells.find((cell) => cell.id !== placement.cellId);
  const copying = startMigration(placement, target);
  const catchup = advanceMigration(copying, "CATCHING_UP");
  const pending = advanceMigration(catchup, "CUTOVER_PENDING");
  const cutover = advanceMigration(pending, "CUTOVER");
  assert.notEqual(cutover.cellId, placement.cellId);
  assert.notEqual(cutover.fenceToken, placement.fenceToken);
  assert.throws(() => assertWriteFence(cutover, placement.cellId, placement.epoch, placement.fenceToken), /STALE_CELL_WRITER/);
});

test("compatibility passport and three-way WordPress sync fail safely", () => {
  const passport = buildCompatibilityPassport({
    coreVersion: "6.8", theme: { slug: "hello-elementor" },
    plugins: [{ slug: "elementor", active: true }, { slug: "unknown-commerce", active: true }],
    gutenbergBlocks: { "core/paragraph": 5 }, elementorWidgets: { heading: 2, mystery: 1 }, shortcodes: { legacy_form: 3 },
  }, "2026-09-14T00:00:00.000Z");
  assert.equal(passport.schemaVersion, 1);
  assert.ok(passport.warnings > 0);
  const base = contentFingerprint({ title: "one" });
  const remote = contentFingerprint({ title: "remote" });
  const desired = contentFingerprint({ title: "desired" });
  assert.equal(decideWordPressSync({ sourceId: "1", baseHash: base, remoteHash: base, desiredHash: desired }).decision, "APPLY");
  assert.equal(decideWordPressSync({ sourceId: "1", baseHash: base, remoteHash: remote, desiredHash: desired }).decision, "CONFLICT");
});

test("media inspection sniffs types, sanitizes SVG and enforces state transitions", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png, 0);
  png.writeUInt32BE(10, 16); png.writeUInt32BE(20, 20);
  const inspected = inspectMedia(png, "application/octet-stream");
  assert.equal(inspected.kind, "PNG"); assert.equal(inspected.width, 10); assert.equal(inspected.height, 20);
  const svg = inspectMedia(Buffer.from('<svg width="5" height="6"><script>alert(1)</script><rect onload="x"/></svg>'), "image/svg+xml");
  assert.equal(svg.kind, "SVG");
  assert.doesNotMatch(Buffer.from(svg.sanitizedBody).toString(), /script|onload/i);
  assert.equal(advanceMediaState("UPLOADING", "QUARANTINED"), "QUARANTINED");
  assert.throws(() => advanceMediaState("READY", "PROCESSING"));
});

test("trusted delivery state never fabricates success", () => {
  const destination = validateTrustedDestination({ id: SITE, tenantId: TENANT, kind: "WEBHOOK", endpoint: "https://hooks.example.com/events", method: "POST", timeoutMs: 5000, maximumResponseBytes: 1024, secret: "secret" });
  const envelope = deliveryEnvelope({ tenantId: TENANT, destinationId: SITE, eventType: "form.submitted", attempt: 1, idempotencyKey: "submission:123456", data: { lead: true } });
  assert.match(webhookHeaders(destination, envelope, JSON.stringify(envelope))["x-forgestudio-signature"], /^v1=/);
  assert.equal(classifyDelivery(503).state, "RETRY_SCHEDULED");
  assert.equal(classifyDelivery(null, "TIMEOUT_AFTER_WRITE").state, "OUTCOME_UNKNOWN");
  assert.equal(nextDeliveryState("IN_PROGRESS", "OUTCOME_UNKNOWN"), "OUTCOME_UNKNOWN");
  assert.equal(retryDelayMs(2, "seed"), retryDelayMs(2, "seed"));
});

test("billing ledger is idempotent, bounded and integer-safe", () => {
  const eventId = randomUUID();
  const entries = [{ eventId, tenantId: TENANT, dimension: "publish", quantity: 2n, occurredAt: "2026-09-14T00:00:00.000Z", source: "publish.worker" }, { eventId, tenantId: TENANT, dimension: "publish", quantity: 2n, occurredAt: "2026-09-14T00:00:00.000Z", source: "publish.worker" }];
  assert.equal(aggregateUsage(entries).publish, 2n);
  const decision = decideUsage(8n, 3n, { dimension: "publish", included: 10n, hardLimit: 20n, overageUnit: 1n, overagePriceMinor: 25n });
  assert.equal(decision.allowed, true); assert.equal(decision.overageAmountMinor, 25n);
  assert.equal(tieredAmountMinor(15n, [{ upTo: 10n, pricePerUnitMinor: 2n }, { pricePerUnitMinor: 1n }]), 25n);
});

test("observability bounds cardinality and redacts secrets", () => {
  const metrics = new MetricsRegistry(2);
  metrics.counter("forgestudio_requests_total", "Requests").add(1, { route: "/health" });
  metrics.histogram("forgestudio_latency_seconds", "Latency", [0.1, 1]).observe(0.2, { route: "/health" });
  assert.match(metrics.renderPrometheus(), /forgestudio_requests_total/);
  assert.match(structuredLog("info", "request.complete", { token: "secret", safe: "yes" }), /\[REDACTED\]/);
});

test("backup manifests and restore evidence require integrity and objectives", () => {
  const manifest = createBackupManifest({
    backupId: "backup-20260914-001", environment: "production", cellId: "blr-a",
    startedAt: "2026-09-14T00:00:00.000Z", completedAt: "2026-09-14T00:05:00.000Z",
    components: [
      { name: "postgres", uri: "s3://backup/db.dump", sha256: "a".repeat(64), bytes: 10, capturedAt: "2026-09-14T00:04:00.000Z", encryption: "KMS" },
      { name: "object-store", uri: "s3://backup/objects.json", sha256: "b".repeat(64), bytes: 20, capturedAt: "2026-09-14T00:05:00.000Z", encryption: "KMS" },
    ],
  }, "signing-key");
  assert.doesNotThrow(() => verifyBackupManifest(manifest, "signing-key"));
  assert.doesNotThrow(() => verifyRestoreEvidence({ backupId: manifest.backupId, restoredAt: "2026-09-14T01:00:00.000Z", targetCellId: "blr-dr", checks: { database_integrity: true, tenant_isolation: true, release_delivery: true, job_reconciliation: true, object_integrity: true }, recoveredTenants: 1, recoveredReleases: 2, pendingJobsReconciled: 0, rpoSeconds: 30, rtoSeconds: 600 }, 60, 900));
});
