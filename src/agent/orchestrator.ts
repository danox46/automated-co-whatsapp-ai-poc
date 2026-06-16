import type { InboundMessage } from "../messages/types.js";
import { getDeliveryGuidance, type DeliveryGuidance } from "../delivery/deliveryGuidance.js";
import { applyResponseGuardrails, type GuardrailResult } from "../guardrails/responseGuardrails.js";
import type { InventoryAvailability } from "../inventory/InventoryProvider.js";
import { MockInventoryProvider } from "../inventory/providers/mockInventoryProvider.js";
import { classifyIntent, type Intent } from "../intents/classifier.js";
import { extractFields, type ExtractedFields } from "../messages/extractFields.js";
import { composeResponse } from "../responses/composeResponse.js";

export type OrchestratorResult = {
  responseText: string;
  shouldSend: boolean;
  trace: ProcessingTrace;
};

export type ProcessingTrace = {
  messageId?: string;
  inboundText: string;
  intent: Intent;
  resolvedIntent: Intent;
  extracted: ExtractedFields;
  inventoryMatches: InventoryAvailability[];
  deliveryGuidance?: DeliveryGuidance;
  guardrails: GuardrailResult;
};

const inventoryProvider = new MockInventoryProvider();

export async function orchestrateInboundMessage(message: InboundMessage): Promise<OrchestratorResult> {
  const intent = await classifyIntent(message);
  const extracted = extractFields(message.body);
  const resolvedIntent = resolveIntent(intent, extracted);
  const inventoryMatches =
    resolvedIntent === "check_availability"
      ? await inventoryProvider.findAvailability({
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
  const composedResponse = composeResponse({
    intent: resolvedIntent,
    extracted,
    inventory: inventoryMatches,
    deliveryGuidance
  });
  const guardrails = applyResponseGuardrails(composedResponse);

  const trace: ProcessingTrace = {
    messageId: message.providerMessageId,
    inboundText: message.body,
    intent,
    resolvedIntent,
    extracted,
    inventoryMatches,
    deliveryGuidance,
    guardrails
  };

  return {
    responseText: guardrails.responseText,
    shouldSend: guardrails.allowed,
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
