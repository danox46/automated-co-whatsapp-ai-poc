import { orchestrateInboundMessage } from "../agent/orchestrator.js";
import { normalizeInboundMessage } from "../messages/normalizeInboundMessage.js";

const sampleInputs = [
  "Tienen mayonesa grande?",
  "Tienes mayonesa grande?",
  "Necesito 2 mayonesas grandes",
  "Tienen arroz de 5kg?",
  "Tienen pack familiar de leche?",
  "Cuanto tarda el envio a Bogota?",
  "Tienen atun pack x6?"
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
