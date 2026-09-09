import { prisma } from "../../config/prisma.js";
import { AppError } from "../../utils/app-error.js";
import { getWebsiteById } from "../website.service.js";

// Compatibility limiter for the current single-node API. The production limiter is wired to
// the Redis control plane in F08; this local limiter fails closed only for this process.
const rateLimitMap = new Map<string, number[]>();

export function sanitizeInput(value: any): any {
  if (typeof value === "string") {
    return value
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<[^>]+>/g, "")
      .trim();
  }
  if (Array.isArray(value)) return value.map(sanitizeInput);
  if (typeof value === "object" && value !== null) {
    const sanitizedObj: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) sanitizedObj[sanitizeInput(key)] = sanitizeInput(val);
    return sanitizedObj;
  }
  return value;
}

export function checkRateLimit(ip: string, maxPerMin = 5): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) || [];
  const recent = timestamps.filter((t) => now - t < 60_000);
  if (recent.length >= maxPerMin) return false;
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return true;
}

export interface FormSubmitPayload {
  websiteId: string;
  formId: string;
  formName: string;
  fields: Record<string, any>;
  // Kept for backwards-compatible UI responses. External destinations supplied by a public
  // request are never trusted or dispatched by the server.
  actions?: {
    activeActions?: string[];
    emailConfig?: { toEmail?: string; subject?: string; fromName?: string; includeMetadata?: boolean };
    webhookConfig?: { endpointUrl?: string; secretKey?: string };
    redirectConfig?: { url?: string; openInNewTab?: boolean };
    popupConfig?: { popupId?: string };
    successMessage?: string;
  };
  spamProtection?: {
    enableHoneypot?: boolean;
    honeypotFieldName?: string;
    rateLimitPerMinute?: number;
  };
  honeypotValue?: string;
  metadata?: { ip?: string; userAgent?: string; referer?: string };
}

/**
 * Public form acceptance is truthful: success means the submission was committed.
 * External actions are never executed from client-provided URLs/addresses. F08/P03 will
 * resolve trusted action definitions server-side and create durable delivery intents.
 */
export async function processFormSubmission(payload: FormSubmitPayload) {
  const { websiteId, formId, formName, fields, actions, spamProtection, honeypotValue, metadata } = payload;
  if (!websiteId || !formId) {
    throw new AppError("Website ID and Form ID are required", 400, "INVALID_FORM_SUBMISSION");
  }

  if (spamProtection?.enableHoneypot !== false && honeypotValue && honeypotValue.trim().length > 0) {
    // Deliberately indistinguishable response for obvious bots; no durable lead is claimed.
    return { success: true, accepted: false, spamDiscarded: true, message: actions?.successMessage || "Thank you for your submission!" };
  }

  const clientIp = metadata?.ip || "unknown";
  const rateLimit = Math.max(1, Math.min(100, spamProtection?.rateLimitPerMinute ?? 5));
  if (!checkRateLimit(clientIp, rateLimit)) {
    throw new AppError("Too many form submissions. Please wait and try again.", 429, "RATE_LIMIT_EXCEEDED");
  }

  const sanitizedFields = sanitizeInput(fields || {});
  const sanitizedMetadata = {
    ip: clientIp,
    userAgent: metadata?.userAgent ? sanitizeInput(metadata.userAgent) : "unknown",
    referer: metadata?.referer ? sanitizeInput(metadata.referer) : "",
    submittedAt: new Date().toISOString(),
  };

  try {
    const dataJsonStr = JSON.stringify(sanitizedFields);
    const metaJsonStr = JSON.stringify(sanitizedMetadata);
    const rows: any[] = await prisma.$queryRaw`
      INSERT INTO form_submissions (id, "websiteId", "formId", "formName", data, metadata, "createdAt")
      VALUES (gen_random_uuid(), ${websiteId}::uuid, ${formId}, ${formName || "Contact Form"}, ${dataJsonStr}::jsonb, ${metaJsonStr}::jsonb, NOW())
      RETURNING id, "createdAt"
    `;
    const receipt = rows[0];
    if (!receipt?.id) throw new Error("No persistence receipt returned");

    const requestedExternalActions = (actions?.activeActions || []).filter((name) => name !== "database");
    return {
      success: true,
      accepted: true,
      persisted: true,
      submissionId: receipt.id,
      acceptedAt: receipt.createdAt,
      message: actions?.successMessage || "Thank you! Your submission has been received.",
      actions: {
        database: "PERSISTED",
        external: requestedExternalActions.length > 0 ? "NOT_DISPATCHED_FROM_CLIENT_CONFIGURATION" : "NONE_REQUESTED",
      },
      redirectUrl: actions?.redirectConfig?.url || undefined,
      openInNewTab: actions?.redirectConfig?.openInNewTab || false,
      popupId: actions?.popupConfig?.popupId || undefined,
    };
  } catch (error) {
    console.error("Form persistence failed", error);
    throw new AppError("Submission could not be durably accepted. Please retry.", 503, "SUBMISSION_NOT_PERSISTED");
  }
}

export async function getWebsiteSubmissions(websiteId: string, userId: string) {
  await getWebsiteById(websiteId, userId);
  const submissions: any[] = await prisma.$queryRaw`
    SELECT id, "websiteId", "formId", "formName", data, metadata, "createdAt"
    FROM form_submissions
    WHERE "websiteId" = ${websiteId}::uuid
    ORDER BY "createdAt" DESC
  `;
  return submissions || [];
}

export async function deleteWebsiteSubmission(websiteId: string, submissionId: string, userId: string) {
  await getWebsiteById(websiteId, userId);
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM form_submissions WHERE id = $1::uuid AND "websiteId" = $2::uuid`,
      submissionId,
      websiteId
    );
    return { success: true };
  } catch (error) {
    console.error("Error deleting form submission:", error);
    throw new AppError("Failed to delete form submission", 500, "DELETE_SUBMISSION_FAILED");
  }
}
