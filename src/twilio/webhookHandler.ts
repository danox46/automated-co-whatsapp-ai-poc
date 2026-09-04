import type { Request, Response } from "express";
import type { AppConfig } from "../config/env.js";
import { createDecisionProvider } from "../agent/createDecisionProvider.js";
import { normalizeInboundMessage } from "../messages/normalizeInboundMessage.js";
import { logger } from "../logging/logger.js";
import { createWebhookEvent, createWebhookEventLog } from "../logging/webhookEventLog.js";
import { composeAdminReviewNotification, normalizeWhatsappTo } from "../notifications/adminReviewNotification.js";
import { orchestrateInboundMessage } from "../agent/orchestrator.js";
import { createInventoryProvider } from "../inventory/createInventoryProvider.js";
import { downloadTwilioMedia } from "../media/mediaStore.js";
import type { OperatorRuntime } from "../operator/runtime.js";
import { InboundMessageBuffer } from "./inboundMessageBuffer.js";

export function createTwilioWhatsappWebhookHandler(config: AppConfig, runtime: OperatorRuntime) {
  const inventoryProvider = createInventoryProvider(config);
  const decisionProvider = createDecisionProvider(config);
  const webhookEventLog = createWebhookEventLog(config.webhookEventLog.path);
  const buffer = new InboundMessageBuffer({
    idleMs: config.inboundBuffer.idleMs,
    onFlush: async (batch) => processInboundMessage(
      batch.combinedMessage,
      batch.messages.map((message) => message.providerMessageId).filter(Boolean) as string[]
    )
  });

  return async function handleTwilioWhatsappWebhook(req: Request, res: Response) {
    try {
      const inboundMessage = normalizeInboundMessage(req.body);
      const persisted = runtime.repository.ingestInbound(inboundMessage);

      if (persisted.created) {
        if (persisted.createdConversation) runtime.events.publish({ type: "conversation.created", data: { conversationId: persisted.conversationId } });
        runtime.events.publish({ type: "message.created", data: { conversationId: persisted.conversationId, messageId: persisted.messageId } });
        runtime.events.publish({ type: "conversation.updated", data: { conversationId: persisted.conversationId } });
        void downloadPendingMedia(persisted.messageId, persisted.conversationId);
        if (inboundMessage.body.trim() && persisted.mode === "bot") buffer.enqueue(inboundMessage);
      }

      logger.info("Accepted Twilio WhatsApp webhook", {
        messageId: inboundMessage.providerMessageId,
        duplicate: !persisted.created,
        mediaCount: inboundMessage.media?.length ?? 0
      });
      res.status(200).type("text/xml").send("<Response></Response>");
    } catch (error) {
      logger.error("Failed to persist Twilio WhatsApp webhook", {
        error: error instanceof Error ? error.message : String(error)
      });
      res.status(400).type("text/xml").send("<Response></Response>");
    }
  };

  async function downloadPendingMedia(messageId: string, conversationId: string) {
    for (const media of runtime.repository.listPendingMedia(messageId)) {
      try {
        const stored = await downloadTwilioMedia(media, {
          accountSid: config.twilio.accountSid,
          authToken: config.twilio.authToken,
          mediaRoot: config.operator.mediaPath
        });
        runtime.repository.updateMedia(media.id, { status: "ready", ...stored });
        runtime.events.publish({ type: "media.ready", data: { conversationId, messageId, mediaId: media.id } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("Unsupported") || message.includes("16 MB") || message.includes("outside Twilio")
          ? "rejected"
          : "failed";
        runtime.repository.updateMedia(media.id, { status, errorMessage: message });
        runtime.events.publish({ type: "media.failed", data: { conversationId, messageId, mediaId: media.id, status } });
      }
    }
  }

  async function processInboundMessage(
    inboundMessage: ReturnType<typeof normalizeInboundMessage>,
    sourceMessageIds: string[]
  ) {
    const conversation = runtime.repository.listConversations().find((item) => item.phone === inboundMessage.from);
    if (!conversation || conversation.mode === "human") return;
    const context = runtime.repository.getConversationContext(conversation.id);

    try {
      const result = await orchestrateInboundMessage(inboundMessage, {
        inventoryProvider,
        decisionProvider,
        conversation: context
      });
      const responseText = result.routeToHuman ? runtime.settings.current.handoffMessage : result.responseText;
      let sendResult: unknown;
      let adminReviewSendResult: unknown;

      if (result.shouldSend && inboundMessage.from) {
        const outbound = runtime.repository.createOutboundMessage({
          conversationId: conversation.id,
          body: responseText,
          author: "bot",
          switchToHuman: result.routeToHuman
        });
        runtime.events.publish({ type: "message.created", data: { conversationId: conversation.id, messageId: outbound.messageId } });
        try {
          sendResult = await runtime.sendMessage(config.twilio, {
            to: inboundMessage.from,
            body: responseText,
            statusCallback: statusCallbackUrl(config.twilio.webhookPublicUrl)
          });
          const typed = sendResult as { sid: string; status: string };
          runtime.repository.attachProviderResult(outbound.messageId, typed.sid, typed.status);
        } catch (error) {
          runtime.repository.markOutboundFailed(outbound.messageId, error);
          throw error;
        } finally {
          runtime.events.publish({ type: "message.status", data: { conversationId: conversation.id, messageId: outbound.messageId } });
        }
      }

      if (result.routeToHuman) {
        runtime.repository.addSystemMessage(conversation.id, "La conversación ahora está en Modo humano");
        runtime.events.publish({ type: "conversation.mode", data: { conversationId: conversation.id, mode: "human" } });
      }

      const adminReviewTo = normalizeWhatsappTo(config.twilio.adminReviewTo);
      if (result.routeToHuman && adminReviewTo) {
        try {
          adminReviewSendResult = await runtime.sendMessage(config.twilio, {
            to: adminReviewTo,
            body: composeAdminReviewNotification({ inbound: inboundMessage, result, conversation: context })
          });
        } catch (error) {
          logger.error("Failed to send admin review WhatsApp notification", {
            inboundMessageId: inboundMessage.providerMessageId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      await webhookEventLog.append(createWebhookEvent({
        status: "processed",
        inbound: inboundMessage,
        conversation: context,
        result: { ...result, responseText },
        sendResult,
        adminReviewSendResult
      }));
      runtime.events.publish({ type: "conversation.updated", data: { conversationId: conversation.id, sourceMessageIds } });
    } catch (error) {
      logger.error("Failed to process persisted WhatsApp message", {
        messageId: inboundMessage.providerMessageId,
        error: error instanceof Error ? error.message : String(error)
      });
      await webhookEventLog.append(createWebhookEvent({ status: "failed", inbound: inboundMessage, conversation: context, error }));
    }
  }
}

export function createTwilioStatusWebhookHandler(runtime: OperatorRuntime) {
  return function handleTwilioStatus(req: Request, res: Response) {
    const messageSid = String(req.body.MessageSid ?? "").trim();
    const status = String(req.body.MessageStatus ?? "").trim().toLowerCase();
    if (!messageSid || !status) {
      res.sendStatus(400);
      return;
    }
    const updated = runtime.repository.updateMessageStatus(messageSid, status, req.body.ErrorCode, req.body.ErrorMessage);
    if (updated) runtime.events.publish({ type: "message.status", data: { providerSid: messageSid, status } });
    res.sendStatus(204);
  };
}

export function statusCallbackUrl(publicUrl?: string) {
  if (!publicUrl) return undefined;
  return new URL("/webhooks/twilio/status", new URL(publicUrl).origin).toString();
}
