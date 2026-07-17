import type { Request, Response } from "express";
import type { AppConfig } from "../config/env.js";
import { createDecisionProvider } from "../agent/createDecisionProvider.js";
import { normalizeInboundMessage } from "../messages/normalizeInboundMessage.js";
import { logger } from "../logging/logger.js";
import { createWebhookEvent, createWebhookEventLog } from "../logging/webhookEventLog.js";
import {
  composeAdminReviewNotification,
  normalizeWhatsappTo
} from "../notifications/adminReviewNotification.js";
import { orchestrateInboundMessage } from "../agent/orchestrator.js";
import { createInventoryProvider } from "../inventory/createInventoryProvider.js";
import { InMemoryConversationSessionStore } from "../sessions/conversationSessionStore.js";
import { InboundMessageBuffer } from "./inboundMessageBuffer.js";
import { sendWhatsappMessage } from "./sendService.js";

export function createTwilioWhatsappWebhookHandler(config: AppConfig) {
  const inventoryProvider = createInventoryProvider(config);
  const decisionProvider = createDecisionProvider(config);
  const sessionStore = new InMemoryConversationSessionStore();
  const webhookEventLog = createWebhookEventLog(config.webhookEventLog.path);
  const buffer = new InboundMessageBuffer({
    idleMs: config.inboundBuffer.idleMs,
    onFlush: async (batch) => {
      await processInboundMessage(batch.combinedMessage);
    }
  });

  return async function handleTwilioWhatsappWebhook(req: Request, res: Response) {
    const inboundMessage = normalizeInboundMessage(req.body);

    logger.info("Received Twilio WhatsApp webhook", {
      messageId: inboundMessage.providerMessageId,
      from: inboundMessage.from,
      body: inboundMessage.body
    });

    const pendingCount = buffer.enqueue(inboundMessage);
    logger.info("Buffered Twilio WhatsApp webhook", {
      messageId: inboundMessage.providerMessageId,
      from: inboundMessage.from,
      pendingCount,
      idleMs: config.inboundBuffer.idleMs
    });

    res.status(200).type("text/xml").send("<Response></Response>");
  };

  async function processInboundMessage(inboundMessage: ReturnType<typeof normalizeInboundMessage>) {
    let conversation = undefined;

    try {
      sessionStore.clearExpired();
      conversation = sessionStore.getContext(inboundMessage);
      const result = await orchestrateInboundMessage(inboundMessage, {
        inventoryProvider,
        decisionProvider,
        conversation
      });

      logger.info("Processed inbound WhatsApp message", {
        trace: result.trace
      });

      if (result.routeToHuman) {
        logger.warn("Agent routed inbound WhatsApp message to human", {
          inboundMessageId: inboundMessage.providerMessageId,
          routeReason: result.trace.agentDecision.routeReason
        });
      }

      let sendResult: unknown;
      let adminReviewSendResult: unknown;
      if (result.shouldSend && inboundMessage.from) {
        sendResult = await sendWhatsappMessage(config.twilio, {
          to: inboundMessage.from,
          body: result.responseText
        });

        logger.info("Sent Twilio WhatsApp response", {
          inboundMessageId: inboundMessage.providerMessageId,
          sendResult
        });
      }

      const adminReviewTo = normalizeWhatsappTo(config.twilio.adminReviewTo);
      if (result.routeToHuman && adminReviewTo) {
        try {
          adminReviewSendResult = await sendWhatsappMessage(config.twilio, {
            to: adminReviewTo,
            body: composeAdminReviewNotification({
              inbound: inboundMessage,
              result,
              conversation
            })
          });

          logger.info("Sent admin review WhatsApp notification", {
            inboundMessageId: inboundMessage.providerMessageId,
            adminReviewTo,
            sendResult: adminReviewSendResult
          });
        } catch (error) {
          logger.error("Failed to send admin review WhatsApp notification", {
            inboundMessageId: inboundMessage.providerMessageId,
            adminReviewTo,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      sessionStore.recordTurn(conversation.participantKey, {
        inbound: {
          direction: "inbound",
          body: inboundMessage.body,
          at: inboundMessage.receivedAt,
          intent: result.trace.intent,
          resolvedIntent: result.trace.resolvedIntent,
          extracted: result.trace.extracted,
          deliveryGuidance: result.trace.deliveryGuidance
        },
        outbound: result.shouldSend
          ? {
              direction: "outbound",
              body: result.responseText,
              at: new Date().toISOString(),
              intent: result.trace.intent,
              resolvedIntent: result.trace.resolvedIntent,
              deliveryGuidance: result.trace.deliveryGuidance
            }
          : undefined,
        automationDisclosureSent:
          conversation.automationDisclosureSent ||
          result.responseText.toLowerCase().includes("asistente automatico")
      });

      await webhookEventLog.append(
        createWebhookEvent({
          status: "processed",
          inbound: inboundMessage,
          conversation,
          result,
          sendResult,
          adminReviewSendResult
        })
      );
    } catch (error) {
      logger.error("Failed to process Twilio WhatsApp webhook", {
        messageId: inboundMessage.providerMessageId,
        error: error instanceof Error ? error.message : String(error)
      });

      await webhookEventLog.append(
        createWebhookEvent({
          status: "failed",
          inbound: inboundMessage,
          conversation,
          error
        })
      );
    }
  }
}
