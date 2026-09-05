import { describe, expect, it } from "vitest";
import { orchestrateInboundMessage } from "./orchestrator.js";
import type { InboundMessage } from "../messages/types.js";
import { MockInventoryProvider } from "../inventory/providers/mockInventoryProvider.js";
import { LocalCliDecisionProvider } from "./localCliDecisionProvider.js";
import { DeterministicDecisionProvider } from "./deterministicDecisionProvider.js";
import type { AgentDecisionProvider } from "./decisionTypes.js";
import type { ConversationContext } from "../sessions/conversationSessionStore.js";
import type { DeliveryGuidanceRequest } from "../delivery/deliveryGuidance.js";

describe("orchestrateInboundMessage", () => {
  it("runs the mocked grocery availability pipeline and returns a trace", async () => {
    const result = await orchestrateInboundMessage(message("Tienen diablitos de 54g?"));

    expect(result.shouldSend).toBe(true);
    expect(result.responseText).toContain("Diablitos Underwood");
    expect(result.trace).toMatchObject({
      intent: "check_availability",
      extracted: {
        productKeywords: ["diablitos"],
        size: "54g"
      },
      inventoryMatches: [
        {
          productName: "Diablitos Underwood",
          variantLabel: "54g x 24 unidades",
          available: true,
          advisoryRole: "requested"
        }
      ]
    });
  });

  it("offers an advisory substitute for an unavailable copied storefront pack", async () => {
    const result = await orchestrateInboundMessage(message("Tienen canelitas pack x3?"));

    expect(result.shouldSend).toBe(true);
    expect(result.trace.inventoryMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ advisoryRole: "requested", available: false }),
        expect.objectContaining({ advisoryRole: "alternative", available: true })
      ])
    );
    expect(result.responseText).toContain("Como alternativa");
    expect(result.responseText).toContain("paquetes individuales");
  });

  it("attempts availability when a product is recognized even if classifier is unclear", async () => {
    const result = await orchestrateInboundMessage(message("canelitas pack x3"));

    expect(result.shouldSend).toBe(true);
    expect(result.trace.intent).toBe("unclear");
    expect(result.trace.resolvedIntent).toBe("check_availability");
    expect(result.trace.extracted).toMatchObject({
      productKeywords: ["canelitas"],
      size: "pack x3"
    });
    expect(result.responseText).toContain("Canelitas");
    expect(result.responseText).toContain("Como alternativa");
  });

  it("answers catalog option questions from grounded inventory data", async () => {
    const result = await orchestrateInboundMessage(message("Que presentaciones de Riko Malt ofrecen?"));

    expect(result.shouldSend).toBe(true);
    expect(result.routeToHuman).toBe(false);
    expect(result.trace.agentDecision.understanding.resolvedIntent).toBe("catalog_options");
    expect(result.responseText).toContain("botella 500ml");
    expect(result.responseText).toContain("500ml x 3 unidades");
  });

  it("asks for clarification before routing a first unclear message to human", async () => {
    const result = await orchestrateInboundMessage(message("Hola"));

    expect(result.shouldSend).toBe(true);
    expect(result.routeToHuman).toBe(false);
    expect(result.trace.intent).toBe("unclear");
    expect(result.trace.resolvedIntent).toBe("unclear");
    expect(result.trace.agentDecision.action).toBe("respond");
    expect(result.responseText).toContain("Me cuentas un poco mas");
    expect(result.responseText).not.toContain("disponibilidad");
    expect(result.responseText).not.toContain("domicilio");
  });

  it("clarifies again after one previous unclear turn", async () => {
    const result = await orchestrateInboundMessage(message("No se"), {
      inventoryProvider: new MockInventoryProvider(),
      decisionProvider: routeWithAcknowledgementProvider(),
      conversation: conversationWithPreviousUnclear()
    });

    expect(result.shouldSend).toBe(true);
    expect(result.routeToHuman).toBe(false);
    expect(result.responseText).toContain("Me cuentas un poco mas");
  });

  it("routes to human after two clarification attempts", async () => {
    const result = await orchestrateInboundMessage(message("No se"), {
      inventoryProvider: new MockInventoryProvider(),
      decisionProvider: routeWithAcknowledgementProvider(),
      conversation: conversationWithTwoPreviousUnclears()
    });

    expect(result.shouldSend).toBe(true);
    expect(result.routeToHuman).toBe(true);
    expect(result.responseText).toContain("equipo");
  });

  it("runs the mocked delivery pipeline and returns an estimate caveat", async () => {
    const result = await orchestrateInboundMessage(message("Cuanto tarda el envio a Bogota?"), {
      inventoryProvider: new MockInventoryProvider(),
      decisionProvider: new DeterministicDecisionProvider(),
      deliveryGuidanceProvider: fixedDeliveryGuidance
    });

    expect(result.shouldSend).toBe(true);
    expect(result.trace.intent).toBe("delivery_guidance");
    expect(result.responseText).toContain("$12.000 COP");
    expect(result.responseText).toContain("estimacion");
  });

  it("recognizes natural delivery price wording before escalating", async () => {
    const result = await orchestrateInboundMessage(message("Cuanto para planeta Rica?"), {
      inventoryProvider: new MockInventoryProvider(),
      decisionProvider: new DeterministicDecisionProvider(),
      deliveryGuidanceProvider: fixedDeliveryGuidance
    });

    expect(result.shouldSend).toBe(true);
    expect(result.routeToHuman).toBe(false);
    expect(result.trace.intent).toBe("delivery_guidance");
    expect(result.trace.resolvedIntent).toBe("delivery_guidance");
    expect(result.trace.deliveryGuidance).toMatchObject({
      department: "Córdoba",
      city: "Planeta Rica",
      needsDepartment: false,
      needsCity: false
    });
    expect(result.responseText).toContain("$28.000 COP");
  });

  it("treats a location-only reply as a delivery follow-up inside a session", async () => {
    const result = await orchestrateInboundMessage(message("Bogota"), {
      inventoryProvider: new MockInventoryProvider(),
      decisionProvider: new LocalCliDecisionProvider({
        command: "node ./node_modules/tsx/dist/cli.mjs src/local/mockAgentCli.ts",
        timeoutMs: 30000
      }),
      deliveryGuidanceProvider: fixedDeliveryGuidance,
      conversation: conversationWithPendingDelivery()
    });

    expect(result.shouldSend).toBe(true);
    expect(result.trace.intent).toBe("unclear");
    expect(result.trace.resolvedIntent).toBe("delivery_guidance");
    expect(result.trace.deliveryGuidance).toMatchObject({
      priceCop: 12000,
      estimatedDelivery: expect.stringContaining("Bogot")
    });
  });

  it("treats an unknown comma-separated location as a delivery follow-up", async () => {
    const result = await orchestrateInboundMessage(message("Córdoba, planeta Rica"), {
      inventoryProvider: new MockInventoryProvider(),
      decisionProvider: new LocalCliDecisionProvider({
        command: "node ./node_modules/tsx/dist/cli.mjs src/local/mockAgentCli.ts",
        timeoutMs: 30000
      }),
      deliveryGuidanceProvider: fixedDeliveryGuidance,
      conversation: conversationWithPendingDelivery()
    });

    expect(result.shouldSend).toBe(true);
    expect(result.routeToHuman).toBe(false);
    expect(result.trace.intent).toBe("unclear");
    expect(result.trace.resolvedIntent).toBe("delivery_guidance");
    expect(result.trace.deliveryGuidance).toMatchObject({
      department: "Córdoba",
      city: "Planeta Rica",
      needsDepartment: false,
      needsCity: false
    });
    expect(result.responseText).toContain("$28.000 COP");
  });

  it("can use the local CLI decision provider contract", async () => {
    const result = await orchestrateInboundMessage(message("Que presentaciones de Riko Malt ofrecen?"), {
      inventoryProvider: new MockInventoryProvider(),
      decisionProvider: new LocalCliDecisionProvider({
        command: "node ./node_modules/tsx/dist/cli.mjs src/local/mockAgentCli.ts",
        timeoutMs: 30000
      })
    });

    expect(result.shouldSend).toBe(true);
    expect(result.trace.agentDecision.understanding.resolvedIntent).toBe("catalog_options");
    expect(result.responseText).toContain("botella 500ml");
  });
});

async function fixedDeliveryGuidance(request: DeliveryGuidanceRequest) {
  const isPlanetaRica = request.cityText?.toLowerCase().includes("planeta rica") ?? false;
  return {
    source: "public_shopify_delivery_calculator" as const,
    sourceUrl: "https://example.test/delivery-calculator",
    department: isPlanetaRica ? "Córdoba" : "Bogota D.C.",
    city: isPlanetaRica ? "Planeta Rica" : "Bogota",
    zone: isPlanetaRica ? "national" : "bogota",
    priceCop: isPlanetaRica ? 28000 : 12000,
    estimatedDelivery: isPlanetaRica ? "2 días hábiles" : "Llega hoy a toda Bogota",
    summary: isPlanetaRica
      ? "Para Planeta Rica, Córdoba, el domicilio aparece en $28.000 COP y la entrega estimada es 2 días hábiles."
      : "Para Bogota, el domicilio aparece en $12.000 COP y la entrega estimada es hoy.",
    caveats: ["Es una estimacion del calculador de domicilio, no una promesa exacta."],
    needsDepartment: false,
    needsCity: false
  };
}

function message(body: string): InboundMessage {
  return {
    provider: "twilio_whatsapp",
    providerMessageId: "SM_TEST",
    from: "whatsapp:+573006211340",
    to: "whatsapp:+14155238886",
    body,
    receivedAt: new Date().toISOString(),
    raw: {}
  };
}

function routeWithAcknowledgementProvider(): AgentDecisionProvider {
  return {
    async decide() {
      return {
        action: "route_to_human",
        responseText: "Gracias. Voy a pasar esto al equipo para revisarlo.",
        routeReason: "Unsupported request.",
        confidence: 0.8,
        understanding: {
          intent: "unclear",
          resolvedIntent: "unclear",
          needsHuman: true
        },
        notes: []
      };
    }
  };
}

function conversationWithPendingDelivery(): ConversationContext {
  return {
    sessionId: "whatsapp_573006211340_1780000000000",
    participantKey: "whatsapp:+573006211340",
    startedAt: "2026-06-16T10:00:00.000Z",
    lastSeenAt: "2026-06-16T10:01:00.000Z",
    windowHours: 24,
    automationDisclosureSent: true,
    turns: [
      {
        direction: "inbound",
        body: "Cuanto cuesta el domicilio?",
        at: "2026-06-16T10:00:00.000Z",
        intent: "delivery_guidance",
        resolvedIntent: "delivery_guidance",
        deliveryGuidance: {
          source: "public_shopify_delivery_calculator",
          sourceUrl: "https://elportalvenezolano.com/products/diablitos?variant=50232260198676",
          summary: "Para calcular el domicilio, dime el departamento y la ciudad o municipio.",
          caveats: ["Las fechas son estimadas, no promesas exactas."],
          needsDepartment: true,
          needsCity: true
        }
      }
    ]
  };
}

function conversationWithPreviousUnclear(): ConversationContext {
  return {
    sessionId: "whatsapp_573006211340_1780000000000",
    participantKey: "whatsapp:+573006211340",
    startedAt: "2026-06-16T10:00:00.000Z",
    lastSeenAt: "2026-06-16T10:01:00.000Z",
    windowHours: 24,
    automationDisclosureSent: true,
    turns: [
      {
        direction: "inbound",
        body: "Hola",
        at: "2026-06-16T10:00:00.000Z",
        intent: "unclear",
        resolvedIntent: "unclear",
        extracted: { productKeywords: [] }
      },
      {
        direction: "outbound",
        body: "No estoy seguro de haber entendido bien. Me cuentas un poco mas para ayudarte?",
        at: "2026-06-16T10:00:01.000Z",
        intent: "unclear",
        resolvedIntent: "unclear"
      }
    ]
  };
}

function conversationWithTwoPreviousUnclears(): ConversationContext {
  return {
    sessionId: "whatsapp_573006211340_1780000000000",
    participantKey: "whatsapp:+573006211340",
    startedAt: "2026-06-16T10:00:00.000Z",
    lastSeenAt: "2026-06-16T10:02:00.000Z",
    windowHours: 24,
    automationDisclosureSent: true,
    turns: [
      {
        direction: "inbound",
        body: "Hola",
        at: "2026-06-16T10:00:00.000Z",
        intent: "unclear",
        resolvedIntent: "unclear",
        extracted: { productKeywords: [] }
      },
      {
        direction: "outbound",
        body: "No estoy seguro de haber entendido bien. Me cuentas un poco mas para ayudarte?",
        at: "2026-06-16T10:00:01.000Z",
        intent: "unclear",
        resolvedIntent: "unclear"
      },
      {
        direction: "inbound",
        body: "No se",
        at: "2026-06-16T10:01:00.000Z",
        intent: "unclear",
        resolvedIntent: "unclear",
        extracted: { productKeywords: [] }
      },
      {
        direction: "outbound",
        body: "No estoy seguro de haber entendido bien. Me cuentas un poco mas para ayudarte?",
        at: "2026-06-16T10:01:01.000Z",
        intent: "unclear",
        resolvedIntent: "unclear"
      }
    ]
  };
}
