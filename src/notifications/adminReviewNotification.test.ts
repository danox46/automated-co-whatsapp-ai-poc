import { describe, expect, it } from "vitest";
import { composeAdminReviewNotification, normalizeWhatsappTo } from "./adminReviewNotification.js";
import type { OrchestratorResult } from "../agent/orchestrator.js";
import type { InboundMessage } from "../messages/types.js";

describe("admin review notification", () => {
  it("composes a concise WhatsApp admin alert", () => {
    const message = composeAdminReviewNotification({
      inbound: inboundMessage("Necesito hablar con alguien"),
      conversation: {
        sessionId: "session_1",
        participantKey: "whatsapp:+573001112233",
        startedAt: "2026-06-16T10:00:00.000Z",
        lastSeenAt: "2026-06-16T10:00:00.000Z",
        windowHours: 24,
        automationDisclosureSent: true,
        turns: []
      },
      result: routeToHumanResult()
    });

    expect(message).toContain("Revision requerida");
    expect(message).toContain("Cliente: whatsapp:+573001112233");
    expect(message).toContain("Sesion: session_1");
    expect(message).toContain("Motivo: Unsupported request.");
  });

  it("normalizes bare phone numbers to Twilio WhatsApp addresses", () => {
    expect(normalizeWhatsappTo("+57 3006211340")).toBe("whatsapp:+573006211340");
    expect(normalizeWhatsappTo("whatsapp:+573006211340")).toBe("whatsapp:+573006211340");
  });
});

function inboundMessage(body: string): InboundMessage {
  return {
    provider: "twilio_whatsapp",
    providerMessageId: "SM_TEST",
    from: "whatsapp:+573001112233",
    to: "whatsapp:+14155238886",
    body,
    receivedAt: "2026-06-16T10:00:00.000Z",
    raw: {}
  };
}

function routeToHumanResult(): OrchestratorResult {
  return {
    responseText: "Te paso con el equipo.",
    shouldSend: true,
    routeToHuman: true,
    trace: {
      messageId: "SM_TEST",
      inboundText: "Necesito hablar con alguien",
      intent: "unclear",
      resolvedIntent: "unclear",
      extracted: { productKeywords: [] },
      catalog: [],
      inventoryMatches: [],
      agentDecision: {
        action: "route_to_human",
        responseText: "Te paso con el equipo.",
        routeReason: "Unsupported request.",
        confidence: 0.8,
        understanding: {
          intent: "unclear",
          resolvedIntent: "unclear",
          needsHuman: true
        },
        notes: []
      },
      guardrails: {
        allowed: true,
        reasons: [],
        responseText: "Te paso con el equipo."
      }
    }
  };
}
