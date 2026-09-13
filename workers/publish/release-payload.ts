import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

type JsonObject = Record<string, any>;
export interface EncryptedPrivateForms {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: 1;
}

const SENSITIVE_KEY = /(secret|password|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)/i;
const MAX_NODES = 50_000;
const MAX_DEPTH = 40;
const MAX_PUBLIC_BYTES = 16 * 1024 * 1024;
const MAX_PRIVATE_BYTES = 4 * 1024 * 1024;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFormDefinition(value: JsonObject): boolean {
  return typeof value.id === "string" && Array.isArray(value.fields) && isObject(value.actions);
}

function clonePrivate(value: unknown): unknown {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > MAX_PRIVATE_BYTES) throw new Error("PUBLISH_PRIVATE_CONFIG_TOO_LARGE");
  return JSON.parse(body);
}

function publicActions(actions: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of ["successMessage", "errorMessage", "redirectConfig", "popupConfig"]) {
    if (actions[key] !== undefined) result[key] = actions[key];
  }
  const active = Array.isArray(actions.activeActions) ? actions.activeActions.map(String) : ["database"];
  result.activeActions = active.filter((name) => name === "database" || name === "redirect" || name === "popup");
  if (!result.activeActions.includes("database")) result.activeActions.unshift("database");
  return result;
}

export function splitReleasePayload(source: unknown): {
  publicPayload: unknown;
  privateForms: Record<string, JsonObject>;
} {
  const privateForms: Record<string, JsonObject> = {};
  let nodes = 0;

  const visit = (value: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new Error("PUBLISH_PAYLOAD_TOO_COMPLEX");
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (!isObject(value)) return value;

    const form = isFormDefinition(value);
    if (form) {
      const id = String(value.id);
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id)) throw new Error("PUBLISH_PRIVATE_CONFIG_INVALID");
      if (privateForms[id]) throw new Error("PUBLISH_DUPLICATE_FORM_ID");
      privateForms[id] = clonePrivate(value) as JsonObject;
    }

    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      if (form && (key === "emailConfig" || key === "webhookConfig" || key === "crmConfig")) continue;
      if (form && key === "actions") {
        result.actions = publicActions(isObject(child) ? child : {});
        continue;
      }
      result[key] = visit(child, depth + 1);
    }
    return result;
  };

  const publicPayload = visit(source, 0);
  if (Buffer.byteLength(JSON.stringify(publicPayload), "utf8") > MAX_PUBLIC_BYTES) throw new Error("PUBLISH_PUBLIC_PAYLOAD_TOO_LARGE");
  if (Buffer.byteLength(JSON.stringify(privateForms), "utf8") > MAX_PRIVATE_BYTES) throw new Error("PUBLISH_PRIVATE_CONFIG_TOO_LARGE");
  return { publicPayload, privateForms };
}

function encryptionKey(input?: string): Buffer {
  const value = input ?? process.env.INTEGRATION_SECRET_KEY_BASE64;
  if (!value) throw new Error("PUBLISH_SECRET_KEY_UNAVAILABLE");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("PUBLISH_SECRET_KEY_INVALID");
  return key;
}

function aad(websiteId: string, releaseId: string): Buffer {
  return Buffer.from(`forgestudio:release-private:v1:${websiteId}:${releaseId}`, "utf8");
}

export function encryptPrivateForms(
  forms: Record<string, JsonObject>,
  websiteId: string,
  releaseId: string,
  keyBase64?: string,
): EncryptedPrivateForms {
  const body = Buffer.from(JSON.stringify(forms), "utf8");
  if (body.length > MAX_PRIVATE_BYTES) throw new Error("PUBLISH_PRIVATE_CONFIG_TOO_LARGE");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyBase64), iv);
  cipher.setAAD(aad(websiteId, releaseId));
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion: 1,
  };
}

export function decryptPrivateForms(
  envelope: EncryptedPrivateForms,
  websiteId: string,
  releaseId: string,
  keyBase64?: string,
): Record<string, JsonObject> {
  if (envelope.keyVersion !== 1) throw new Error("PUBLISH_SECRET_KEY_VERSION_UNSUPPORTED");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyBase64), Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(aad(websiteId, releaseId));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  if (plaintext.length > MAX_PRIVATE_BYTES) throw new Error("PUBLISH_PRIVATE_CONFIG_TOO_LARGE");
  const parsed = JSON.parse(plaintext.toString("utf8"));
  if (!isObject(parsed)) throw new Error("PUBLISH_PRIVATE_CONFIG_INVALID");
  return parsed;
}
