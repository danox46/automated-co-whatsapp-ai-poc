import { mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { OrchestratorResult } from "../agent/orchestrator.js";
import type { ConversationContext } from "../sessions/conversationSessionStore.js";
import type { InboundMessage } from "../messages/types.js";

export type WebhookEventStatus = "processed" | "failed";

export type WebhookEvent = {
  eventType: "twilio_whatsapp_webhook";
  status: WebhookEventStatus;
  recordedAt: string;
  inbound: {
    providerMessageId?: string;
    from?: string;
    to?: string;
    body: string;
    receivedAt: string;
    messageCount: number;
    batchedMessages?: Array<{
      providerMessageId?: string;
      from?: string;
      to?: string;
      body: string;
      receivedAt: string;
    }>;
  };
  session?: {
    sessionId: string;
    participantKey: string;
    startedAt: string;
    lastSeenAt: string;
    windowHours: number;
    automationDisclosureSent: boolean;
    turnCount: number;
  };
  result?: {
    shouldSend: boolean;
    routeToHuman: boolean;
    responseText: string;
    sendResult?: unknown;
    adminReviewSendResult?: unknown;
    trace: OrchestratorResult["trace"];
  };
  error?: {
    message: string;
  };
};

export class WebhookEventLog {
  constructor(private readonly filePath: string) {}

  async append(event: WebhookEvent) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export function createWebhookEventLog(filePath?: string) {
  return new WebhookEventLog(resolve(filePath ?? ".runtime/webhook-events.jsonl"));
}

export function createWebhookEvent(input: {
  status: WebhookEventStatus;
  inbound: InboundMessage;
  conversation?: ConversationContext;
  result?: OrchestratorResult;
  sendResult?: unknown;
  adminReviewSendResult?: unknown;
  error?: unknown;
}): WebhookEvent {
  return {
    eventType: "twilio_whatsapp_webhook",
    status: input.status,
    recordedAt: new Date().toISOString(),
    inbound: {
      providerMessageId: input.inbound.providerMessageId,
      from: input.inbound.from,
      to: input.inbound.to,
      body: input.inbound.body,
      receivedAt: input.inbound.receivedAt,
      messageCount: getBatchedMessages(input.inbound).length || 1,
      batchedMessages: getBatchedMessages(input.inbound)
    },
    session: input.conversation
      ? {
          sessionId: input.conversation.sessionId,
          participantKey: input.conversation.participantKey,
          startedAt: input.conversation.startedAt,
          lastSeenAt: input.conversation.lastSeenAt,
          windowHours: input.conversation.windowHours,
          automationDisclosureSent: input.conversation.automationDisclosureSent,
          turnCount: input.conversation.turns.length
        }
      : undefined,
    result: input.result
      ? {
          shouldSend: input.result.shouldSend,
          routeToHuman: input.result.routeToHuman,
          responseText: input.result.responseText,
          sendResult: input.sendResult,
          adminReviewSendResult: input.adminReviewSendResult,
          trace: input.result.trace
        }
      : undefined,
    error: input.error
      ? {
          message: input.error instanceof Error ? input.error.message : String(input.error)
        }
      : undefined
  };
}

function getBatchedMessages(inbound: InboundMessage) {
  if (
    inbound.raw &&
    typeof inbound.raw === "object" &&
    "batchedMessages" in inbound.raw &&
    Array.isArray(inbound.raw.batchedMessages)
  ) {
    return inbound.raw.batchedMessages as Array<{
      providerMessageId?: string;
      from?: string;
      to?: string;
      body: string;
      receivedAt: string;
    }>;
  }

  return [];
}
