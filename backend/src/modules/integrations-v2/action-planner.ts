type JsonObject = Record<string, any>;

export type DeliveryActionType = "EMAIL" | "WEBHOOK" | "CRM";

export interface PlannedDeliveryAction {
  type: DeliveryActionType;
  actionName: "email" | "webhook" | "crm";
  actionIndex: number;
  provider: string;
  config: JsonObject;
}

export interface RejectedDeliveryAction {
  actionName: string;
  code: string;
  details: JsonObject;
}

export interface DeliveryPlan {
  actions: PlannedDeliveryAction[];
  rejected: RejectedDeliveryAction[];
  requested: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function boundedString(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : "";
}

function httpsUrl(value: unknown): string {
  const text = boundedString(value, 2_048);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function propertyMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [source, destination] of Object.entries(object(value)).slice(0, 100)) {
    if (/^[A-Za-z0-9_.-]{1,100}$/.test(source) && typeof destination === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(destination)) {
      result[source] = destination;
    }
  }
  return result;
}

function reject(actionName: string, code: string): RejectedDeliveryAction {
  return { actionName, code, details: {} };
}

function planEmail(actions: JsonObject, index: number): PlannedDeliveryAction | RejectedDeliveryAction {
  const config = object(actions.emailConfig);
  const provider = boundedString(config.provider || "SENDGRID", 80).toUpperCase();
  const toEmail = boundedString(config.toEmail, 320);
  const fromEmail = boundedString(config.fromEmail, 320);
  const apiKey = boundedString(config.apiKey, 512);
  const subject = boundedString(config.subject || "New website lead", 300);
  const fromName = boundedString(config.fromName || "ForgeStudio", 120);
  if (provider !== "SENDGRID") return reject("email", "EMAIL_PROVIDER_UNSUPPORTED");
  if (!EMAIL.test(toEmail) || !EMAIL.test(fromEmail) || apiKey.length < 20 || !subject) {
    return reject("email", "EMAIL_CONFIGURATION_INVALID");
  }
  return {
    type: "EMAIL",
    actionName: "email",
    actionIndex: index,
    provider,
    config: { provider, toEmail, fromEmail, fromName, subject, apiKey },
  };
}

function planWebhook(actions: JsonObject, index: number): PlannedDeliveryAction | RejectedDeliveryAction {
  const config = object(actions.webhookConfig);
  const endpointUrl = httpsUrl(config.endpointUrl);
  const secretKey = boundedString(config.secretKey, 512);
  if (!endpointUrl) return reject("webhook", "WEBHOOK_CONFIGURATION_INVALID");
  return {
    type: "WEBHOOK",
    actionName: "webhook",
    actionIndex: index,
    provider: "WEBHOOK",
    config: { provider: "WEBHOOK", endpointUrl, secretKey: secretKey || undefined },
  };
}

function planCrm(actions: JsonObject, index: number): PlannedDeliveryAction | RejectedDeliveryAction {
  const config = object(actions.crmConfig);
  const provider = boundedString(config.provider || "", 80).toUpperCase();
  if (provider === "HUBSPOT") {
    const accessToken = boundedString(config.accessToken, 2_048);
    const emailField = boundedString(config.emailField || "email", 100);
    if (accessToken.length < 20 || !/^[A-Za-z0-9_.-]{1,100}$/.test(emailField)) {
      return reject("crm", "CRM_CONFIGURATION_INVALID");
    }
    return {
      type: "CRM",
      actionName: "crm",
      actionIndex: index,
      provider,
      config: { provider, accessToken, emailField, propertyMap: propertyMap(config.propertyMap) },
    };
  }
  if (provider === "GENERIC_REST") {
    const endpointUrl = httpsUrl(config.endpointUrl);
    const bearerToken = boundedString(config.bearerToken, 4_096);
    if (!endpointUrl) return reject("crm", "CRM_CONFIGURATION_INVALID");
    return {
      type: "CRM",
      actionName: "crm",
      actionIndex: index,
      provider,
      config: { provider, endpointUrl, bearerToken: bearerToken || undefined, propertyMap: propertyMap(config.propertyMap) },
    };
  }
  return reject("crm", "CRM_PROVIDER_UNSUPPORTED");
}

export function planTrustedDeliveryActions(actionsInput: unknown): DeliveryPlan {
  const actions = object(actionsInput);
  const requested = Array.isArray(actions.activeActions)
    ? [...new Set(actions.activeActions.map((value: unknown) => String(value).trim().toLowerCase()))].slice(0, 16)
    : [];
  const planned: PlannedDeliveryAction[] = [];
  const rejected: RejectedDeliveryAction[] = [];
  let index = 0;
  for (const actionName of requested) {
    let result: PlannedDeliveryAction | RejectedDeliveryAction | undefined;
    if (actionName === "email") result = planEmail(actions, index);
    else if (actionName === "webhook") result = planWebhook(actions, index);
    else if (actionName === "crm") result = planCrm(actions, index);
    else continue;
    if ("type" in result) planned.push(result);
    else rejected.push(result);
    index += 1;
    if (planned.length + rejected.length >= 8) break;
  }
  return { actions: planned, rejected, requested };
}
