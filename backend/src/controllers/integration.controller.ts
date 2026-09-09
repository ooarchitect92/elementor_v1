import type { Request, Response } from "express";
import { IntegrationService } from "../services/integration.service.js";

function sendIntegrationResult(res: Response, result: any) {
  if (result?.success === true) return res.status(200).json(result);
  if (result?.outcome === "UPSTREAM_REJECTED") return res.status(502).json(result);
  if (result?.outcome === "FETCH_FAILED") return res.status(502).json(result);
  if (result?.outcome === "NOT_CONFIGURED" || result?.outcome === "DURABLE_DELIVERY_REQUIRED") {
    return res.status(503).json(result);
  }
  return res.status(500).json({ success: false, outcome: "INTEGRATION_FAILED", ...result });
}

export class IntegrationController {
  public static async createPayPalOrder(req: Request, res: Response) {
    try {
      const { amount = "29.99", currency = "USD", itemName = "Subscription" } = req.body;
      return sendIntegrationResult(res, await IntegrationService.createPayPalOrder(amount, currency, itemName));
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error?.message || "PayPal order creation failed" });
    }
  }

  public static async capturePayPalOrder(req: Request, res: Response) {
    try {
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ success: false, message: "orderId is required" });
      return sendIntegrationResult(res, await IntegrationService.capturePayPalOrder(orderId));
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error?.message || "PayPal order capture failed" });
    }
  }

  public static async createStripeCheckoutSession(req: Request, res: Response) {
    try {
      const { amount = "49.00", currency = "USD", itemName = "Pro Plan" } = req.body;
      return sendIntegrationResult(res, await IntegrationService.createStripeCheckoutSession(amount, currency, itemName));
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error?.message || "Stripe session creation failed" });
    }
  }

  public static async fetchDynamicData(req: Request, res: Response) {
    try {
      const targetUrl = req.query.url as string;
      const jsonPath = req.query.jsonPath as string;
      if (!targetUrl) return res.status(400).json({ success: false, message: "Query parameter 'url' is required" });
      return sendIntegrationResult(res, await IntegrationService.fetchDynamicData(targetUrl, jsonPath));
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error?.message || "Dynamic data fetch failed" });
    }
  }

  public static async submitLeadToCRM(req: Request, res: Response) {
    try {
      const { provider = "hubspot", name, email, customFields } = req.body;
      if (!name || !email) return res.status(400).json({ success: false, message: "Name and email are required for CRM sync" });
      return sendIntegrationResult(res, await IntegrationService.submitLeadToCRM(provider, name, email, customFields));
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error?.message || "CRM lead submission failed" });
    }
  }

  public static async dispatchWebhook(req: Request, res: Response) {
    try {
      const { webhookUrl, eventType = "onButtonClick", payload, secret } = req.body;
      if (!webhookUrl) return res.status(400).json({ success: false, message: "webhookUrl is required" });
      return sendIntegrationResult(res, await IntegrationService.dispatchWebhook(webhookUrl, eventType, payload, secret));
    } catch (error: any) {
      return res.status(500).json({ success: false, message: error?.message || "Webhook dispatch failed" });
    }
  }
}
