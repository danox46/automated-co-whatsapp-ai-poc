import type { Request, Response } from "express";
import type { AppConfig } from "../config/env.js";
import { normalizeInboundMessage } from "../messages/normalizeInboundMessage.js";
import { logger } from "../logging/logger.js";
import { orchestrateInboundMessage } from "../agent/orchestrator.js";
import { sendWhatsappMessage } from "./sendService.js";

export function createTwilioWhatsappWebhookHandler(config: AppConfig) {
  return async function handleTwilioWhatsappWebhook(req: Request, res: Response) {
    const inboundMessage = normalizeInboundMessage(req.body);

    logger.info("Received Twilio WhatsApp webhook", {
      messageId: inboundMessage.providerMessageId,
      from: inboundMessage.from,
      body: inboundMessage.body
    });

    try {
      const result = await orchestrateInboundMessage(inboundMessage);

      logger.info("Processed inbound WhatsApp message", {
        trace: result.trace
      });

      if (result.shouldSend && inboundMessage.from) {
        const sendResult = await sendWhatsappMessage(config.twilio, {
          to: inboundMessage.from,
          body: result.responseText
        });

        logger.info("Sent Twilio WhatsApp response", {
          inboundMessageId: inboundMessage.providerMessageId,
          sendResult
        });
      }

      res.status(200).type("text/xml").send("<Response></Response>");
    } catch (error) {
      logger.error("Failed to process Twilio WhatsApp webhook", {
        messageId: inboundMessage.providerMessageId,
        error: error instanceof Error ? error.message : String(error)
      });

      res.status(500).type("text/xml").send("<Response></Response>");
    }
  };
}
