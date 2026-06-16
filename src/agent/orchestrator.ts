import type { InboundMessage } from "../messages/types.js";
import { getDeliveryGuidance, type DeliveryGuidance } from "../delivery/deliveryGuidance.js";
import { applyResponseGuardrails, type GuardrailResult } from "../guardrails/responseGuardrails.js";
import type {
  InventoryAvailability,
  InventoryCatalogProduct,
  InventoryProvider
} from "../inventory/InventoryProvider.js";
import { MockInventoryProvider } from "../inventory/providers/mockInventoryProvider.js";
import { classifyIntent, type Intent } from "../intents/classifier.js";
import { extractFields, type ExtractedFields } from "../messages/extractFields.js";
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
  catalog: InventoryCatalogProduct[];
  inventoryMatches: InventoryAvailability[];
  deliveryGuidance?: DeliveryGuidance;
  agentDecision: AgentDecision;
  guardrails: GuardrailResult;
};

export type OrchestratorDependencies = {
  inventoryProvider: InventoryProvider;
  decisionProvider: AgentDecisionProvider;
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
  const resolvedIntent = resolveIntent(intent, extracted);
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
      ? await getDeliveryGuidance({
          destinationText: extracted.city,
          productText: extracted.productKeywords.join(" ")
        })
      : undefined;
  const agentDecision = await dependencies.decisionProvider.decide({
    message,
    extracted,
    catalog,
    inventoryMatches,
    deliveryGuidance
  });
  const guardrails = applyResponseGuardrails(agentDecision.responseText ?? "");
  const routeToHuman = agentDecision.action === "route_to_human";

  const trace: ProcessingTrace = {
    messageId: message.providerMessageId,
    inboundText: message.body,
    intent,
    resolvedIntent,
    extracted,
    catalog,
    inventoryMatches,
    deliveryGuidance,
    agentDecision,
    guardrails
  };

  return {
    responseText: guardrails.responseText,
    shouldSend: !routeToHuman && guardrails.allowed,
    routeToHuman,
    trace
  };
}

function resolveIntent(intent: Intent, extracted: ExtractedFields): Intent {
  if (intent === "delivery_guidance") {
    return intent;
  }

  if (extracted.productKeywords.length > 0) {
    return "check_availability";
  }

  return intent;
}
