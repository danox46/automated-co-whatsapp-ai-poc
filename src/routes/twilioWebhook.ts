import { Router } from "express";
import type { AppConfig } from "../config/env.js";
import { createTwilioWhatsappWebhookHandler } from "../twilio/webhookHandler.js";

export function createTwilioWebhookRouter(config: AppConfig) {
  const twilioWebhookRouter = Router();
  twilioWebhookRouter.post("/whatsapp", createTwilioWhatsappWebhookHandler(config));
  return twilioWebhookRouter;
}
