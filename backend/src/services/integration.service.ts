import { pinnedJsonRequest } from "../modules/wordpress/safe-http.js";

interface CacheEntry {
  data: any;
  timestamp: number;
}

const DYNAMIC_DATA_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;

function cachePut(key: string, value: CacheEntry) {
  if (!DYNAMIC_DATA_CACHE.has(key) && DYNAMIC_DATA_CACHE.size >= CACHE_MAX_ENTRIES) {
    const oldest = DYNAMIC_DATA_CACHE.keys().next().value;
    if (oldest) DYNAMIC_DATA_CACHE.delete(oldest);
  }
  DYNAMIC_DATA_CACHE.set(key, value);
}

function notConfigured(provider: string, capability: string) {
  return {
    success: false,
    accepted: false,
    outcome: "NOT_CONFIGURED",
    provider,
    capability,
    message: `${provider} ${capability} is not connected to a verified provider adapter yet.`,
  };
}

export class IntegrationService {
  // Legacy demonstration endpoints remain callable for UI compatibility, but never fabricate
  // provider identifiers, checkout URLs, captures or successful external side effects.
  public static async createPayPalOrder(amount: string, currency: string, itemName: string) {
    return { ...notConfigured("paypal", "create_order"), amount, currency, itemName };
  }

  public static async capturePayPalOrder(orderId: string) {
    return { ...notConfigured("paypal", "capture_order"), orderId };
  }

  public static async createStripeCheckoutSession(amount: string, currency: string, itemName: string) {
    return { ...notConfigured("stripe", "checkout_session"), amount, currency, itemName };
  }

  public static async fetchDynamicData(targetUrl: string, jsonPath?: string) {
    const cacheKey = `${targetUrl}:${jsonPath || ""}`;
    const now = Date.now();
    const cached = DYNAMIC_DATA_CACHE.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) return cached.data;
    if (cached) DYNAMIC_DATA_CACHE.delete(cacheKey);

    try {
      // Reuse the pinned, public-address-only HTTPS transport. Redirects and private-address
      // resolution are rejected so this endpoint cannot be used as a simple metadata/LAN proxy.
      const response = await pinnedJsonRequest<any>(targetUrl, {}, { timeoutMs: 8_000, maxBytes: 2 * 1024 * 1024 });
      if (response.status < 200 || response.status >= 300) {
        return { success: false, outcome: "UPSTREAM_REJECTED", status: response.status, url: targetUrl };
      }
      const json = response.body;
      let value = json;
      if (jsonPath && typeof json === "object" && json !== null) {
        const parts = jsonPath.split(".").filter(Boolean).slice(0, 20);
        let current: any = json;
        for (const part of parts) {
          if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, part)) current = current[part];
          else { current = undefined; break; }
        }
        value = current !== undefined ? current : json;
      }
      const result = { success: true, value, url: targetUrl, jsonPath };
      cachePut(cacheKey, { data: result, timestamp: now });
      return result;
    } catch (error: any) {
      return { success: false, outcome: "FETCH_FAILED", error: error?.message || "Failed to fetch dynamic data source", url: targetUrl };
    }
  }

  public static async submitLeadToCRM(provider: string, name: string, email: string, customFields?: Record<string, any>) {
    return {
      ...notConfigured(String(provider || "crm").toLowerCase(), "lead_delivery"),
      lead: { name, email, ...customFields },
    };
  }

  public static async dispatchWebhook(webhookUrl: string, eventType: string, payload?: any, _secret?: string) {
    // Direct network dispatch from a synchronous request is intentionally disabled. The durable
    // delivery worker will resolve a trusted, stored destination and persist every attempt.
    return {
      success: false,
      accepted: false,
      outcome: "DURABLE_DELIVERY_REQUIRED",
      eventType,
      webhookUrl,
      payloadPresent: payload !== undefined,
      message: "Direct webhook dispatch is disabled. Configure a trusted durable integration delivery.",
    };
  }
}
