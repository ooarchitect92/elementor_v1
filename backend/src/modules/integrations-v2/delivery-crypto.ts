import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { AppError } from "../../utils/app-error.js";

export interface DeliverySecretEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: 1;
}

function key(): Buffer {
  const encoded = process.env.INTEGRATION_SECRET_KEY_BASE64 || "";
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32) {
    throw new AppError("Integration secret encryption is not configured", 503, "INTEGRATION_SECRET_KEY_NOT_CONFIGURED");
  }
  return value;
}

function aad(tenantId: string, jobId: string): Buffer {
  return Buffer.from(`forgestudio:delivery:v1:${tenantId}:${jobId}`, "utf8");
}

export function stableJson(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  const normalize = (item: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 40) throw new AppError("Integration configuration is too complex", 409, "INTEGRATION_CONFIG_TOO_COMPLEX");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((entry) => normalize(entry, depth + 1));
    if (!item || typeof item !== "object" || seen.has(item)) throw new AppError("Integration configuration is invalid", 409, "INTEGRATION_CONFIG_INVALID");
    seen.add(item);
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(item as Record<string, unknown>).sort()) {
      if (["__proto__", "prototype", "constructor"].includes(name)) throw new AppError("Integration configuration is invalid", 409, "INTEGRATION_CONFIG_INVALID");
      result[name] = normalize((item as Record<string, unknown>)[name], depth + 1);
    }
    seen.delete(item);
    return result;
  };
  const body = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(body, "utf8") > 128 * 1024) throw new AppError("Integration configuration is too large", 409, "INTEGRATION_CONFIG_TOO_LARGE");
  return body;
}

export function deliveryHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function encryptDeliveryConfig(value: unknown, tenantId: string, jobId: string): DeliverySecretEnvelope {
  const body = Buffer.from(stableJson(value), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(aad(tenantId, jobId));
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion: 1,
  };
}
