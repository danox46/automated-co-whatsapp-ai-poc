import type { InboundMessage } from "../messages/types.js";
import {
  getDeliveryGuidance,
  type DeliveryGuidance,
  type DeliveryGuidanceRequest
} from "../delivery/deliveryGuidance.js";
import { applyResponseGuardrails, type GuardrailResult } from "../guardrails/responseGuardrails.js";
import type {
  InventoryAvailability,
  InventoryCatalogProduct,
  InventoryProvider
} from "../inventory/InventoryProvider.js";
import { MockInventoryProvider } from "../inventory/providers/mockInventoryProvider.js";
import { classifyIntent, type Intent } from "../intents/classifier.js";
import { extractFields, type ExtractedFields } from "../messages/extractFields.js";
import type { ConversationContext } from "../sessions/conversationSessionStore.js";
import { DeterministicDecisionProvider } from "./deterministicDecisionProvider.js";
import type { AgentDecision, AgentDecisionProvider } from "./decisionTypes.js";

export type OrchestratorResult = {
  responseText: string;
  shouldSend: boolean;
  routeToHuman: boolean;
  trace: ProcessingTrace;
};

export type ProcessingTrace = {
  messageId?: string;
  inboundText: string;
  intent: Intent;
  resolvedIntent: Intent;
  extracted: ExtractedFields;
  conversation?: ConversationContext;
  catalog: InventoryCatalogProduct[];
  inventoryMatches: InventoryAvailability[];
  deliveryGuidance?: DeliveryGuidance;
  agentDecision: AgentDecision;
  guardrails: GuardrailResult;
};

export type OrchestratorDependencies = {
  inventoryProvider: InventoryProvider;
  decisionProvider: AgentDecisionProvider;
  deliveryGuidanceProvider?: (request: DeliveryGuidanceRequest) => Promise<DeliveryGuidance>;
  conversation?: ConversationContext;
};

const defaultDependencies: OrchestratorDependencies = {
  inventoryProvider: new MockInventoryProvider(),
  decisionProvider: new DeterministicDecisionProvider()
};

export async function orchestrateInboundMessage(
  message: InboundMessage,
  dependencies: OrchestratorDependencies = defaultDependencies
): Promise<OrchestratorResult> {
  const intent = await classifyIntent(message);
  const extracted = extractFields(message.body);
  const resolvedIntent = resolveIntent(intent, extracted, message.body, dependencies.conversation);
  const catalog = await dependencies.inventoryProvider.listCatalog();
  const inventoryMatches =
    resolvedIntent === "check_availability"
      ? await dependencies.inventoryProvider.findAvailability({
          searchText: message.body,
          productKeywords: extracted.productKeywords,
          requestedQuantity: extracted.requestedQuantity,
          size: extracted.size
        })
      : [];
  const deliveryGuidance =
    resolvedIntent === "delivery_guidance"
      ? await (dependencies.deliveryGuidanceProvider ?? getDeliveryGuidance)(
          buildDeliveryGuidanceRequest(message.body, extracted)
        )
      : undefined;
  const agentDecision = await dependencies.decisionProvider.decide({
    message,
    conversation: dependencies.conversation,
    extracted,
    catalog,
    inventoryMatches,
    deliveryGuidance
  });
  const finalAgentDecision = applyUnclearRecoveryPolicy(
    agentDecision,
    resolvedIntent,
    dependencies.conversation
  );
  const responseForGuardrails =
    finalAgentDecision.action === "route_to_human"
      ? finalAgentDecision.responseText ?? defaultHumanHandoffResponse()
      : finalAgentDecision.responseText ?? "";
  const guardrails = applyResponseGuardrails(responseForGuardrails);
  const routeToHuman = finalAgentDecision.action === "route_to_human";

  const trace: ProcessingTrace = {
    messageId: message.providerMessageId,
    inboundText: message.body,
    intent,
    resolvedIntent,
    extracted,
    conversation: dependencies.conversation,
    catalog,
    inventoryMatches,
    deliveryGuidance,
    agentDecision: finalAgentDecision,
    guardrails
  };

  return {
    responseText: guardrails.responseText,
    shouldSend: guardrails.allowed,
    routeToHuman,
    trace
  };
}

function resolveIntent(
  intent: Intent,
  extracted: ExtractedFields,
  text: string,
  conversation?: ConversationContext
): Intent {
  if (intent === "delivery_guidance") {
    return intent;
  }

  if (isDeliveryFollowUp(extracted, text, conversation)) {
    return "delivery_guidance";
  }

  if (extracted.productKeywords.length > 0) {
    return "check_availability";
  }

  return intent;
}

function isDeliveryFollowUp(
  extracted: ExtractedFields,
  text: string,
  conversation?: ConversationContext
) {
  if (!conversation || extracted.productKeywords.length > 0) {
    return false;
  }

  if (!hasPendingDeliveryTurn(conversation)) {
    return false;
  }

  return Boolean(extracted.department || extracted.city || looksLikeLooseLocation(text));
}

function hasPendingDeliveryTurn(conversation: ConversationContext) {
  return conversation.turns
    .slice()
    .reverse()
    .some((turn) => {
      if (turn.direction !== "outbound" && turn.direction !== "inbound") {
        return false;
      }

      return (
        turn.resolvedIntent === "delivery_guidance" ||
        turn.deliveryGuidance?.needsDepartment === true ||
        turn.deliveryGuidance?.needsCity === true
      );
    });
}

function buildDeliveryGuidanceRequest(text: string, extracted: ExtractedFields) {
  const fallbackLocation = parseLooseLocation(text);

  return {
    departmentText: extracted.department ?? fallbackLocation.department,
    cityText: extracted.city ?? fallbackLocation.city,
    productText: extracted.productKeywords.join(" ")
  };
}

function parseLooseLocation(text: string) {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return {
      department: parts[0],
      city: parts.slice(1).join(", ")
    };
  }

  return {};
}

function looksLikeLooseLocation(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < 3 || trimmed.length > 80) {
    return false;
  }

  return trimmed.includes(",") || /^[\p{L}\s.'-]+$/u.test(trimmed);
}

function defaultHumanHandoffResponse() {
  return "Gracias. Voy a pasar tu solicitud a alguien del equipo para que te ayude.";
}

function applyUnclearRecoveryPolicy(
  decision: AgentDecision,
  resolvedIntent: Intent,
  conversation?: ConversationContext
): AgentDecision {
  if (resolvedIntent !== "unclear") {
    return decision;
  }

  const previousUnclearCount = countPreviousConsecutiveUnclearInbounds(conversation);

  if (previousUnclearCount >= 2) {
    return {
      ...decision,
      action: "route_to_human",
      responseText: decision.responseText ?? defaultHumanHandoffResponse(),
      notes: [...decision.notes, "Escalated after two clarification attempts."]
    };
  }

  return {
    action: "respond",
    responseText: "No estoy seguro de haber entendido bien. Me cuentas un poco mas para ayudarte?",
    confidence: 0.5,
    understanding: {
      intent: "unclear",
      resolvedIntent: "unclear",
      needsHuman: false
    },
    notes: [
      ...decision.notes,
      "Recovered unclear turn with a clarification instead of immediate escalation."
    ]
  };
}

function countPreviousConsecutiveUnclearInbounds(conversation?: ConversationContext) {
  let count = 0;

  for (const turn of conversation?.turns.slice().reverse() ?? []) {
    if (turn.direction !== "inbound") {
      continue;
    }

    if (turn.resolvedIntent !== "unclear") {
      break;
    }

    count += 1;
  }

  return count;
}
