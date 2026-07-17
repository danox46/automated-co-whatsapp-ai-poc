import type { InboundMessage } from "../messages/types.js";

export type Intent = "check_availability" | "delivery_guidance" | "unclear";

const availabilityKeywords = [
  "tienen",
  "tienes",
  "hay",
  "disponible",
  "disponibilidad",
  "stock",
  "queda",
  "quedan",
  "consigo",
  "necesito",
  "quiero",
  "do you have",
  "available",
  "in stock"
];

const deliveryKeywords = [
  "envio",
  "envío",
  "domicilio",
  "delivery",
  "entrega",
  "llega",
  "tarda",
  "demora",
  "mandan",
  "cuanto cuesta",
  "cuánto cuesta",
  "cuanto para",
  "cuánto para",
  "costo de envio",
  "precio del envio"
];

export async function classifyIntent(message: InboundMessage): Promise<Intent> {
  const text = message.body.toLowerCase();

  if (availabilityKeywords.some((keyword) => text.includes(keyword))) {
    return "check_availability";
  }

  if (deliveryKeywords.some((keyword) => text.includes(keyword))) {
    return "delivery_guidance";
  }

  return "unclear";
}
