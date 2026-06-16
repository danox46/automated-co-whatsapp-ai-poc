import type { DeliveryGuidance } from "../delivery/deliveryGuidance.js";
import type { InventoryAvailability } from "../inventory/InventoryProvider.js";
import type { Intent } from "../intents/classifier.js";
import type { ExtractedFields } from "../messages/extractFields.js";

export type ResponseCompositionInput = {
  intent: Intent;
  extracted: ExtractedFields;
  inventory?: InventoryAvailability[];
  deliveryGuidance?: DeliveryGuidance;
};

export function composeResponse(input: ResponseCompositionInput): string {
  if (input.intent === "delivery_guidance") {
    return composeDeliveryResponse(input.deliveryGuidance);
  }

  if (input.intent === "check_availability") {
    return composeAvailabilityResponse(input);
  }

  return "Claro. Puedo ayudarte a revisar disponibilidad o tiempos de envio. Que producto o ciudad quieres consultar?";
}

function composeDeliveryResponse(deliveryGuidance?: DeliveryGuidance) {
  if (!deliveryGuidance) {
    return "Para estimar el envio, dime la ciudad de destino.";
  }

  return `${deliveryGuidance.summary} ${deliveryGuidance.caveats[0]}`;
}

function composeAvailabilityResponse(input: ResponseCompositionInput) {
  const matches = input.inventory ?? [];

  if (matches.length === 0) {
    return "No encontre ese producto en el inventario de prueba. Puedo revisar mayonesa, arroz, leche o atun. Que producto quieres consultar?";
  }

  const productNames = new Set(matches.map((match) => match.productName));
  if (productNames.size > 1) {
    return `Encontre varias opciones: ${Array.from(productNames).join(", ")}. Cual quieres revisar?`;
  }

  const productName = matches[0]?.productName ?? "ese producto";
  const hasVariants = matches.length > 1;
  const requestedQuantity = input.extracted.requestedQuantity;

  if (hasVariants && !input.extracted.size) {
    const quantityText = requestedQuantity ? ` ${requestedQuantity} unidades de` : "";
    return `Para revisar${quantityText} ${productName}, me dices que presentacion necesitas? Por ejemplo grande, mediana, 1kg o familiar.`;
  }

  const requestedMatches = matches.filter((match) => match.advisoryRole === "requested");
  const alternativeMatches = matches.filter((match) => match.advisoryRole === "alternative");
  const upsellMatches = matches.filter((match) => match.advisoryRole === "upsell");
  const availableMatches = requestedMatches.filter((match) => match.available === true);

  if (requestedQuantity && matches.length > 0) {
    const quantityMatch = requestedMatches.find(
      (match) => (match.quantityAvailable ?? 0) >= requestedQuantity
    );

    if (quantityMatch) {
      const variantText = quantityMatch.variantLabel ? ` (${quantityMatch.variantLabel})` : "";
      const upsellText = formatUpsell(upsellMatches);
      return `Si, en el inventario de prueba aparece disponibilidad para ${requestedQuantity} de ${productName}${variantText}. Puedes verlo aqui: ${quantityMatch.productUrl}${upsellText}`;
    }

    const checkedVariant = requestedMatches[0]?.variantLabel ? ` ${requestedMatches[0].variantLabel}` : "";
    const alternativeText = formatAlternative(alternativeMatches, requestedQuantity);
    return `Por ahora no aparece suficiente disponibilidad para ${requestedQuantity} de ${productName}${checkedVariant} en el inventario de prueba.${alternativeText}`;
  }

  if (availableMatches.length > 0) {
    const match = availableMatches[0];
    const variantText = match?.variantLabel ? ` (${match.variantLabel})` : "";
    const upsellText = formatUpsell(upsellMatches);
    return `Si, en el inventario de prueba aparece disponible ${productName}${variantText}. Puedes verlo aqui: ${match?.productUrl}${upsellText}`;
  }

  const checkedVariant = requestedMatches[0]?.variantLabel ? ` ${requestedMatches[0].variantLabel}` : "";
  const alternativeText = formatAlternative(alternativeMatches, requestedQuantity ?? 1);
  return `Por ahora no aparece disponible ${productName}${checkedVariant} en el inventario de prueba.${alternativeText}`;
}

function formatAlternative(matches: InventoryAvailability[], requestedQuantity: number) {
  const alternative = matches.find((match) => match.available === true);
  if (!alternative) {
    return " Quieres que revise otra presentacion o producto parecido?";
  }

  return ` ${alternative.advisoryText ?? "Tengo una alternativa disponible."} Te serviria?`;
}

function formatUpsell(matches: InventoryAvailability[]) {
  const upsell = matches.find((match) => match.advisoryText);
  return upsell?.advisoryText ? ` ${upsell.advisoryText}` : "";
}
