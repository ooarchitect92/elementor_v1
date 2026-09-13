import { createDecipheriv } from "node:crypto";

export interface DeliverySecretEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

function key(): Buffer {
  const encoded = process.env.INTEGRATION_SECRET_KEY_BASE64 || "";
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32) throw new Error("INTEGRATION_SECRET_KEY_INVALID");
  return value;
}

function aad(tenantId: string, jobId: string): Buffer {
  return Buffer.from(`forgestudio:delivery:v1:${tenantId}:${jobId}`, "utf8");
}

export function decryptDeliveryConfig(
  envelope: DeliverySecretEnvelope,
  tenantId: string,
  jobId: string,
): Record<string, unknown> {
  if (envelope.keyVersion !== 1) throw new Error("INTEGRATION_SECRET_KEY_VERSION_UNSUPPORTED");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(aad(tenantId, jobId));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  if (plaintext.length > 128 * 1024) throw new Error("INTEGRATION_CONFIG_TOO_LARGE");
  const value = JSON.parse(plaintext.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INTEGRATION_CONFIG_INVALID");
  return value as Record<string, unknown>;
}
