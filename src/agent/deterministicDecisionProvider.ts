import { composeResponse } from "../responses/composeResponse.js";
import type { AgentDecision, AgentDecisionProvider, AgentDecisionRequest } from "./decisionTypes.js";

const optionKeywords = [
  "tamanos",
  "tamaños",
  "presentaciones",
  "opciones",
  "sizes",
  "size",
  "formats",
  "offer",
  "ofrecen",
  "venden"
];

export class DeterministicDecisionProvider implements AgentDecisionProvider {
  async decide(request: AgentDecisionRequest): Promise<AgentDecision> {
    const catalogProduct = findCatalogProduct(request);
    const asksForOptions = optionKeywords.some((keyword) =>
      normalizeText(request.message.body).includes(keyword)
    );

    if (catalogProduct && asksForOptions) {
      return {
        action: "respond",
        responseText: composeCatalogOptionsResponse(catalogProduct),
        confidence: 0.78,
        understanding: {
          intent: "unclear",
          resolvedIntent: "catalog_options",
          needsHuman: false
        },
        notes: ["Detected product plus catalog/options wording."]
      };
    }

    if (request.inventoryMatches.length > 0 || request.deliveryGuidance) {
      const resolvedIntent = request.deliveryGuidance ? "delivery_guidance" : "check_availability";
      const responseText = composeResponse({
        intent: resolvedIntent,
        extracted: request.extracted,
        inventory: request.inventoryMatches,
        deliveryGuidance: request.deliveryGuidance
      });

      return {
        action: "respond",
        responseText,
        confidence: 0.72,
        understanding: {
          intent: resolvedIntent,
          resolvedIntent,
          needsHuman: false
        },
        notes: ["Used deterministic grounded response composition."]
      };
    }

    if (request.extracted.productKeywords.length === 0) {
      return {
        action: "route_to_human",
        routeReason: "No recognizable product, delivery signal, or catalog option request.",
        confidence: 0.35,
        understanding: {
          intent: "unclear",
          resolvedIntent: "unclear",
          needsHuman: true
        },
        notes: ["No grounded product match was available."]
      };
    }

    return {
      action: "respond",
      responseText:
        "No encontre ese producto en el inventario de prueba. Puedo revisar mayonesa, arroz, leche o atun. Que producto quieres consultar?",
      confidence: 0.5,
      understanding: {
        intent: "unclear",
        resolvedIntent: "unclear",
        needsHuman: false
      },
      notes: ["Product-like text was present, but no catalog match was found."]
    };
  }
}

function findCatalogProduct(request: AgentDecisionRequest) {
  const productKeywords = new Set(request.extracted.productKeywords.map(normalizeText));

  return request.catalog.find((product) =>
    product.keywords.some((keyword) => productKeywords.has(normalizeText(keyword)))
  );
}

function composeCatalogOptionsResponse(product: NonNullable<ReturnType<typeof findCatalogProduct>>) {
  const variants = product.variants
    .map((variant) => `${variant.label}${variant.available ? "" : " (no disponible)"}`)
    .join(", ");

  return `Para ${product.name}, tenemos estas presentaciones en el inventario de prueba: ${variants}.`;
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
