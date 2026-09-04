import { Router } from "express";
import type { AppConfig } from "../config/env.js";
import type { OperatorRuntime } from "../operator/runtime.js";
import { createTwilioStatusWebhookHandler, createTwilioWhatsappWebhookHandler } from "../twilio/webhookHandler.js";
import { createTwilioSignatureMiddleware } from "../twilio/signatureValidation.js";

export function createTwilioWebhookRouter(config: AppConfig, runtime: OperatorRuntime) {
  const twilioWebhookRouter = Router();
  const validateSignature = createTwilioSignatureMiddleware({
    authToken: config.twilio.authToken,
    publicUrl: config.twilio.webhookPublicUrl
  });
  twilioWebhookRouter.post("/whatsapp", validateSignature, createTwilioWhatsappWebhookHandler(config, runtime));
  twilioWebhookRouter.post("/status", validateSignature, createTwilioStatusWebhookHandler(runtime));
  return twilioWebhookRouter;
}
