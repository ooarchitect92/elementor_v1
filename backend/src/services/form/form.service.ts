import { randomUUID } from "node:crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/app-error.js";
import { consumeFixedWindow } from "../../platform/redis-runtime.js";
import { decryptReleaseFormDefinitions } from "../../modules/core-v1/release-privacy.js";
import { persistFormSubmissionAndDeliveries } from "../../modules/integrations-v2/form-delivery.service.js";
import { getWebsiteById } from "../website.service.js";

const WEBSITE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORM_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const POPUP_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const REQUEST_KEY = /^[A-Za-z0-9:_-]{16,128}$/;
const LOCAL_LIMIT_MAX_KEYS = 10_000;
const localLimits = new Map<string, { count: number; resetAt: number }>();
type JsonObject = Record<string, any>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeInput(value: any): any {
  if (typeof value === "string") return value.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "").replace(/<[^>]+>/g, "").trim();
  if (Array.isArray(value)) return value.map(sanitizeInput);
  if (isObject(value)) {
    const sanitized: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) sanitized[key] = sanitizeInput(item);
    return sanitized;
  }
  return value;
}

function localFixedWindow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (localLimits.size >= LOCAL_LIMIT_MAX_KEYS) {
    for (const [entry, state] of localLimits) if (state.resetAt <= now) localLimits.delete(entry);
    while (localLimits.size >= LOCAL_LIMIT_MAX_KEYS) localLimits.delete(localLimits.keys().next().value as string);
  }
  const current = localLimits.get(key);
  if (!current || current.resetAt <= now) {
    localLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

export function checkRateLimit(subject: string, maxPerMin = 5): boolean {
  return localFixedWindow(subject, Math.max(1, Math.min(100, maxPerMin)), 60_000);
}

function publicFormLimit(): number {
  const value = Number(process.env.PUBLIC_FORM_RATE_LIMIT_PER_MINUTE || 5);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new AppError("Invalid form limiter configuration", 500, "FORM_LIMIT_CONFIGURATION_INVALID");
  }
  return value;
}

async function enforcePublicFormLimit(websiteId: string, formId: string, clientIp: string) {
  const limit = publicFormLimit();
  const subject = `${websiteId}:${formId}:${clientIp}`;
  try {
    const result = await consumeFixedWindow("public-form", subject, limit, 60_000);
    if (!result.allowed) throw new AppError("Too many form submissions. Please wait and try again.", 429, "RATE_LIMIT_EXCEEDED");
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (process.env.NODE_ENV === "production") {
      throw new AppError("Form submission protection is temporarily unavailable. Please retry.", 503, "RATE_LIMIT_UNAVAILABLE");
    }
    if (!localFixedWindow(subject, limit, 60_000)) {
      throw new AppError("Too many form submissions. Please wait and try again.", 429, "RATE_LIMIT_EXCEEDED");
    }
  }
}

interface TrustedField {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
  options?: Array<{ value: string }>;
}

interface TrustedForm {
  id: string;
  formName: string;
  fields: TrustedField[];
  actions: JsonObject;
}

interface TrustedFormContext {
  tenantId: string;
  releaseId: string;
  form: TrustedForm;
}

function normalizeForm(value: JsonObject, formId: string): TrustedForm {
  if (String(value.id || "") !== formId || !Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 100) {
    throw new AppError("Published form definition is invalid", 409, "FORM_DEFINITION_INVALID");
  }
  const fields: TrustedField[] = value.fields.map((field: any) => {
    if (!isObject(field) || !FIELD_NAME.test(String(field.name || ""))) {
      throw new AppError("Published form definition is invalid", 409, "FORM_DEFINITION_INVALID");
    }
    const options = Array.isArray(field.options)
      ? field.options.slice(0, 200).map((option: any) => ({ value: String(isObject(option) ? option.value : option) }))
      : undefined;
    return {
      name: String(field.name),
      type: String(field.type || "text"),
      required: field.required === true,
      defaultValue: field.defaultValue,
      options,
    };
  });
  return {
    id: formId,
    formName: String(value.formName || "Contact Form").slice(0, 200),
    fields,
    actions: isObject(value.actions) ? value.actions : {},
  };
}

async function loadTrustedForm(websiteId: string, formId: string): Promise<TrustedFormContext> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT r.id AS "releaseId",r."websiteId",w."userId" AS "tenantId",
            p."formDefinitionsCiphertext" AS ciphertext,p."formDefinitionsIv" AS iv,
            p."formDefinitionsTag" AS tag,p."keyVersion"
     FROM site_releases r
     JOIN site_release_private p ON p."releaseId"=r.id
     JOIN websites w ON w.id=r."websiteId"
     WHERE r."websiteId"=$1::uuid AND r.status='ACTIVE' LIMIT 1`,
    websiteId,
  );
  const row = rows[0];
  if (!row) {
    throw new AppError("Published form configuration is unavailable; republish the website", 409, "PUBLISHED_FORM_CONFIGURATION_MISSING");
  }
  try {
    const definitions = decryptReleaseFormDefinitions(row);
    const value = definitions[formId];
    if (!isObject(value)) throw new AppError("Published form not found", 404, "PUBLISHED_FORM_NOT_FOUND");
    return {
      tenantId: String(row.tenantId),
      releaseId: String(row.releaseId),
      form: normalizeForm(value, formId),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    console.error(JSON.stringify({ event: "release.private.decrypt_failed", releaseId: row.releaseId }));
    throw new AppError("Published form configuration is temporarily unavailable", 503, "FORM_CONFIGURATION_UNAVAILABLE");
  }
}

function validateAndSelectFields(form: TrustedForm, submitted: unknown): JsonObject {
  if (!isObject(submitted)) throw new AppError("Form fields must be an object", 400, "INVALID_FORM_FIELDS");
  if (Object.keys(submitted).length > 100 || Buffer.byteLength(JSON.stringify(submitted), "utf8") > 65_536) {
    throw new AppError("Form submission is too large", 413, "FORM_SUBMISSION_TOO_LARGE");
  }
  const definitions = new Map(form.fields.map((field) => [field.name, field]));
  for (const name of Object.keys(submitted)) {
    if (!definitions.has(name)) throw new AppError("Submission contains an unknown field", 400, "UNKNOWN_FORM_FIELD");
  }
  const selected: JsonObject = {};
  for (const field of form.fields) {
    const raw = submitted[field.name] ?? field.defaultValue;
    const empty = raw === undefined || raw === null || raw === "";
    if (field.required && (empty || (field.type === "checkbox" && raw !== true))) {
      throw new AppError(`Required field is missing: ${field.name}`, 400, "REQUIRED_FORM_FIELD_MISSING");
    }
    if (empty) continue;
    if (field.type === "checkbox") {
      if (typeof raw !== "boolean") throw new AppError("Invalid checkbox field", 400, "INVALID_FORM_FIELD");
      selected[field.name] = raw;
      continue;
    }
    if (typeof raw !== "string" && typeof raw !== "number") throw new AppError("Invalid form field", 400, "INVALID_FORM_FIELD");
    const value = String(raw);
    if (value.length > 20_000) throw new AppError("Form field is too large", 413, "FORM_FIELD_TOO_LARGE");
    if (field.type === "email" && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 320)) {
      throw new AppError("Invalid email field", 400, "INVALID_FORM_FIELD");
    }
    if (field.type === "number" && !Number.isFinite(Number(value))) throw new AppError("Invalid number field", 400, "INVALID_FORM_FIELD");
    if ((field.type === "select" || field.type === "radio") && field.options?.length && !new Set(field.options.map((option) => option.value)).has(value)) {
      throw new AppError("Invalid form option", 400, "INVALID_FORM_FIELD");
    }
    selected[field.name] = value;
  }
  return sanitizeInput(selected);
}

function safeResponseActions(actions: JsonObject) {
  const successMessage = sanitizeInput(String(actions.successMessage || "Thank you! Your submission has been received.")).slice(0, 500);
  const redirectConfig = isObject(actions.redirectConfig) ? actions.redirectConfig : {};
  const redirectValue = String(redirectConfig.url || "");
  const redirectUrl = /^\/(?!\/)[^\r\n]{0,2047}$/.test(redirectValue) ? redirectValue : undefined;
  const popupConfig = isObject(actions.popupConfig) ? actions.popupConfig : {};
  const popupValue = String(popupConfig.popupId || "");
  const popupId = POPUP_ID.test(popupValue) ? popupValue : undefined;
  return {
    successMessage,
    redirectUrl,
    openInNewTab: Boolean(redirectUrl && redirectConfig.openInNewTab === true),
    popupId,
  };
}

export interface FormSubmitPayload {
  websiteId: string;
  formId: string;
  formName?: string;
  fields: Record<string, any>;
  actions?: JsonObject;
  spamProtection?: JsonObject;
  honeypotValue?: string;
  requestKey?: string;
  requestId?: string;
  metadata?: { ip?: string; userAgent?: string; referer?: string };
}

export async function processFormSubmission(payload: FormSubmitPayload) {
  const { websiteId, formId, fields, honeypotValue, metadata } = payload;
  if (!WEBSITE_UUID.test(String(websiteId || "")) || !FORM_ID.test(String(formId || ""))) {
    throw new AppError("Website ID and Form ID are invalid", 400, "INVALID_FORM_SUBMISSION");
  }
  const clientIp = String(metadata?.ip || "unknown").slice(0, 128);
  await enforcePublicFormLimit(websiteId, formId, clientIp);
  if (typeof honeypotValue === "string" && honeypotValue.trim().length > 0) {
    return { success: true, accepted: false, spamDiscarded: true, message: "Thank you! Your submission has been received." };
  }

  const trusted = await loadTrustedForm(websiteId, formId);
  const sanitizedFields = validateAndSelectFields(trusted.form, fields);
  const responseActions = safeResponseActions(trusted.form.actions);
  const sanitizedMetadata = {
    ip: clientIp,
    userAgent: metadata?.userAgent ? sanitizeInput(String(metadata.userAgent)).slice(0, 512) : "unknown",
    referer: metadata?.referer ? sanitizeInput(String(metadata.referer)).slice(0, 2_048) : "",
    submittedAt: new Date().toISOString(),
  };
  const submissionKey = payload.requestKey && REQUEST_KEY.test(payload.requestKey)
    ? payload.requestKey
    : `form:${randomUUID()}`;

  try {
    const persisted = await persistFormSubmissionAndDeliveries({
      tenantId: trusted.tenantId,
      websiteId,
      releaseId: trusted.releaseId,
      formId,
      formName: trusted.form.formName,
      fields: sanitizedFields,
      metadata: sanitizedMetadata,
      actions: trusted.form.actions,
      requestKey: submissionKey,
      requestId: payload.requestId,
    });
    return {
      success: true,
      accepted: true,
      persisted: true,
      submissionId: persisted.submissionId,
      acceptedAt: persisted.acceptedAt,
      replayed: persisted.replayed,
      message: responseActions.successMessage,
      actions: { database: "PERSISTED", external: persisted.deliveries.state },
      deliveries: persisted.deliveries,
      redirectUrl: responseActions.redirectUrl,
      openInNewTab: responseActions.openInNewTab,
      popupId: responseActions.popupId,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    console.error("Form persistence failed", error);
    throw new AppError("Submission could not be durably accepted. Please retry.", 503, "SUBMISSION_NOT_PERSISTED");
  }
}

export async function getWebsiteSubmissions(websiteId: string, userId: string) {
  await getWebsiteById(websiteId, userId);
  const submissions: any[] = await prisma.$queryRaw`
    SELECT f.id,f."websiteId",f."releaseId",f."formId",f."formName",f.data,f.metadata,f."createdAt",
      COALESCE((SELECT COUNT(*)::integer FROM platform.integration_delivery_resources d WHERE d.submission_id=f.id),0) AS "deliveryCount",
      COALESCE((SELECT COUNT(*)::integer FROM platform.integration_delivery_issues i WHERE i.submission_id=f.id AND i.resolved_at IS NULL),0) AS "deliveryIssueCount"
    FROM form_submissions f WHERE f."websiteId"=${websiteId}::uuid ORDER BY f."createdAt" DESC
  `;
  return submissions || [];
}

export async function deleteWebsiteSubmission(websiteId: string, submissionId: string, userId: string) {
  await getWebsiteById(websiteId, userId);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM form_submissions WHERE id=$1::uuid AND "websiteId"=$2::uuid`, submissionId, websiteId);
    return { success: true };
  } catch (error) {
    console.error("Error deleting form submission:", error);
    throw new AppError("Failed to delete form submission", 500, "DELETE_SUBMISSION_FAILED");
  }
}
