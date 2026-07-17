import { orchestrateInboundMessage } from "../agent/orchestrator.js";
import { normalizeInboundMessage } from "../messages/normalizeInboundMessage.js";

const sampleInputs = [
  "Tienen Diablitos de 54g?",
  "Tienes Riko Malt 500ml?",
  "Necesito 2 maltas Riko Malt",
  "Que presentaciones de Golden Manzanita ofrecen?",
  "Tienen Canelitas pack x3?",
  "Tienen Sopa Maggi 62g?",
  "Cuanto cuesta el domicilio a Medellin, Antioquia?",
  "Cuanto cuesta el domicilio?",
  "Cuanto para Planeta Rica?"
];

const results = await Promise.all(
  sampleInputs.map(async (input, index) => {
    const sampleMessage = normalizeInboundMessage({
      MessageSid: `SM_DEMO_${index + 1}`,
      From: "whatsapp:+15551234567",
      To: "whatsapp:+15557654321",
      Body: input
    });

    const result = await orchestrateInboundMessage(sampleMessage);

    return {
      input,
      classifiedIntent: result.trace.intent,
      resolvedIntent: result.trace.resolvedIntent,
      agentDecision: result.trace.agentDecision,
      routeToHuman: result.routeToHuman,
      extractedFields: result.trace.extracted,
      matchedProducts: result.trace.inventoryMatches.map((match) => ({
        productName: match.productName,
        variant: match.variantLabel,
        available: match.available,
        quantityAvailable: match.quantityAvailable,
        advisoryRole: match.advisoryRole,
        advisoryText: match.advisoryText,
        productUrl: match.productUrl
      })),
      deliveryGuidance: result.trace.deliveryGuidance,
      responseText: result.responseText
    };
  })
);

console.log(JSON.stringify(results, null, 2));
