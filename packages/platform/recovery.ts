import { createHash, createHmac } from "node:crypto";

export interface BackupComponent {
  name: "postgres" | "object-store" | "kafka-offsets" | "configuration";
  uri: string;
  sha256: string;
  bytes: number;
  capturedAt: string;
  encryption: "AES256" | "KMS" | "PROVIDER_MANAGED";
}

export interface BackupManifest {
  schemaVersion: 1;
  backupId: string;
  environment: string;
  cellId: string;
  startedAt: string;
  completedAt: string;
  databaseLsn?: string;
  components: readonly BackupComponent[];
  manifestHash: string;
  signature?: string;
}

export interface RestoreEvidence {
  backupId: string;
  restoredAt: string;
  targetCellId: string;
  checks: Readonly<Record<string, boolean>>;
  recoveredTenants: number;
  recoveredReleases: number;
  pendingJobsReconciled: number;
  rpoSeconds: number;
  rtoSeconds: number;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function createBackupManifest(input: Omit<BackupManifest, "schemaVersion" | "manifestHash" | "signature">, signingSecret?: string): BackupManifest {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.backupId) || !/^[a-z0-9-]{2,40}$/.test(input.environment) || !/^[a-z0-9-]{2,63}$/.test(input.cellId)) {
    throw new Error("INVALID_BACKUP_IDENTITY");
  }
  const started = new Date(input.startedAt).getTime();
  const completed = new Date(input.completedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) throw new Error("INVALID_BACKUP_TIME");
  if (input.components.length < 2 || input.components.length > 20) throw new Error("INVALID_BACKUP_COMPONENTS");
  const names = new Set<string>();
  for (const component of input.components) {
    if (names.has(component.name) || !/^[0-9a-f]{64}$/.test(component.sha256) || !Number.isSafeInteger(component.bytes) || component.bytes < 0
      || !Number.isFinite(new Date(component.capturedAt).getTime()) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(component.uri)) {
      throw new Error("INVALID_BACKUP_COMPONENT");
    }
    names.add(component.name);
  }
  if (!names.has("postgres") || !names.has("object-store")) throw new Error("INCOMPLETE_BACKUP");
  const base = { schemaVersion: 1 as const, ...input };
  const manifestHash = digest(base);
  const manifest: BackupManifest = { ...base, manifestHash };
  if (signingSecret) manifest.signature = createHmac("sha256", signingSecret).update(manifestHash).digest("hex");
  return manifest;
}

export function verifyBackupManifest(manifest: BackupManifest, signingSecret?: string): void {
  const { manifestHash, signature, ...base } = manifest;
  if (digest(base) !== manifestHash) throw new Error("BACKUP_MANIFEST_HASH_MISMATCH");
  if (signingSecret) {
    const expected = createHmac("sha256", signingSecret).update(manifestHash).digest("hex");
    if (signature !== expected) throw new Error("BACKUP_MANIFEST_SIGNATURE_MISMATCH");
  }
}

export function verifyRestoreEvidence(evidence: RestoreEvidence, maximumRpoSeconds: number, maximumRtoSeconds: number): void {
  if (!Number.isSafeInteger(maximumRpoSeconds) || !Number.isSafeInteger(maximumRtoSeconds) || maximumRpoSeconds < 0 || maximumRtoSeconds < 1) {
    throw new Error("INVALID_RECOVERY_OBJECTIVES");
  }
  if (!Number.isFinite(new Date(evidence.restoredAt).getTime()) || evidence.recoveredTenants < 0 || evidence.recoveredReleases < 0
    || evidence.pendingJobsReconciled < 0 || evidence.rpoSeconds < 0 || evidence.rtoSeconds < 0) {
    throw new Error("INVALID_RESTORE_EVIDENCE");
  }
  const requiredChecks = ["database_integrity", "tenant_isolation", "release_delivery", "job_reconciliation", "object_integrity"];
  for (const check of requiredChecks) if (evidence.checks[check] !== true) throw new Error(`RESTORE_CHECK_FAILED:${check}`);
  if (evidence.rpoSeconds > maximumRpoSeconds) throw new Error("RPO_BREACH");
  if (evidence.rtoSeconds > maximumRtoSeconds) throw new Error("RTO_BREACH");
}
