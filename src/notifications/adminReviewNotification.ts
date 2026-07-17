import type { OrchestratorResult } from "../agent/orchestrator.js";
import type { ConversationContext } from "../sessions/conversationSessionStore.js";
import type { InboundMessage } from "../messages/types.js";

export type AdminReviewNotificationInput = {
  inbound: InboundMessage;
  result: OrchestratorResult;
  conversation?: ConversationContext;
};

export function composeAdminReviewNotification(input: AdminReviewNotificationInput) {
  const reason =
    input.result.trace.agentDecision.routeReason ??
    input.result.trace.agentDecision.notes[0] ??
    "El bot marco esta conversacion para revision.";
  const customer = input.inbound.from ?? "cliente desconocido";
  const sessionId = input.conversation?.sessionId ?? "sin sesion";
  const intent = input.result.trace.resolvedIntent;

  return [
    "Revision requerida en WhatsApp",
    `Cliente: ${customer}`,
    `Sesion: ${sessionId}`,
    `Intento detectado: ${intent}`,
    `Mensaje: ${truncate(input.inbound.body, 240)}`,
    `Motivo: ${truncate(reason, 240)}`
  ].join("\n");
}

export function normalizeWhatsappTo(value?: string) {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("whatsapp:")) {
    return trimmed;
  }

  return `whatsapp:${trimmed.replace(/\s+/g, "")}`;
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
