import { createDecipheriv } from "node:crypto";

type JsonObject = Record<string, any>;
const SENSITIVE_KEY = /(secret|password|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)/i;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFormDefinition(value: JsonObject): boolean {
  return typeof value.id === "string" && Array.isArray(value.fields) && isObject(value.actions);
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

export function redactPublicReleasePayload(source: unknown): unknown {
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 40 || ++nodes > 50_000) throw new Error("PUBLIC_RELEASE_TOO_COMPLEX");
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (!isObject(value)) return value;
    const form = isFormDefinition(value);
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
  return visit(source, 0);
}

function key(): Buffer {
  const value = process.env.INTEGRATION_SECRET_KEY_BASE64;
  if (!value) throw new Error("INTEGRATION_SECRET_KEY_UNAVAILABLE");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error("INTEGRATION_SECRET_KEY_INVALID");
  return decoded;
}

export function decryptReleaseFormDefinitions(row: {
  releaseId: string;
  websiteId: string;
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}): Record<string, JsonObject> {
  if (row.keyVersion !== 1) throw new Error("INTEGRATION_SECRET_KEY_VERSION_UNSUPPORTED");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(row.iv, "base64"));
  decipher.setAAD(Buffer.from(`forgestudio:release-private:v1:${row.websiteId}:${row.releaseId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]);
  if (plaintext.length > 4 * 1024 * 1024) throw new Error("PRIVATE_FORM_CONFIG_TOO_LARGE");
  const parsed = JSON.parse(plaintext.toString("utf8"));
  if (!isObject(parsed)) throw new Error("PRIVATE_FORM_CONFIG_INVALID");
  return parsed;
}
