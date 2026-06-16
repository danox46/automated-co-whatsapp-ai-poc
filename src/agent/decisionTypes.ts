import type { DeliveryGuidance } from "../delivery/deliveryGuidance.js";
import type {
  InventoryAvailability,
  InventoryCatalogProduct
} from "../inventory/InventoryProvider.js";
import type { Intent } from "../intents/classifier.js";
import type { ExtractedFields } from "../messages/extractFields.js";
import type { InboundMessage } from "../messages/types.js";

export type AgentAction = "respond" | "route_to_human";

export type AgentUnderstanding = {
  intent: Intent;
  resolvedIntent: Intent | "catalog_options";
  needsHuman: boolean;
};

export type AgentDecisionRequest = {
  message: InboundMessage;
  extracted: ExtractedFields;
  catalog: InventoryCatalogProduct[];
  inventoryMatches: InventoryAvailability[];
  deliveryGuidance?: DeliveryGuidance;
};

export type AgentDecision = {
  action: AgentAction;
  responseText?: string;
  routeReason?: string;
  confidence: number;
  understanding: AgentUnderstanding;
  notes: string[];
};

export interface AgentDecisionProvider {
  decide(request: AgentDecisionRequest): Promise<AgentDecision>;
}
