import { describe, expect, it } from "vitest";
import { orchestrateInboundMessage } from "./orchestrator.js";
import type { InboundMessage } from "../messages/types.js";

describe("orchestrateInboundMessage", () => {
  it("runs the mocked grocery availability pipeline and returns a trace", async () => {
    const result = await orchestrateInboundMessage(message("Tienen arroz de 5kg?"));

    expect(result.shouldSend).toBe(true);
    expect(result.responseText).toContain("Arroz");
    expect(result.trace).toMatchObject({
      intent: "check_availability",
      extracted: {
        productKeywords: ["arroz"],
        size: "5kg"
      },
      inventoryMatches: [
        {
          productName: "Arroz",
          variantLabel: "bolsa 5kg",
          available: true,
          advisoryRole: "requested"
        }
      ]
    });
  });

  it("offers an advisory substitute for unavailable large mayo", async () => {
    const result = await orchestrateInboundMessage(message("Tienen mayonesa grande?"));

    expect(result.shouldSend).toBe(true);
    expect(result.trace.inventoryMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ advisoryRole: "requested", available: false }),
        expect.objectContaining({ advisoryRole: "alternative", available: true })
      ])
    );
    expect(result.responseText).toContain("Como alternativa");
    expect(result.responseText).toContain("frascos medianos");
  });

  it("attempts availability when a product is recognized even if classifier is unclear", async () => {
    const result = await orchestrateInboundMessage(message("mayonesa grande"));

    expect(result.shouldSend).toBe(true);
    expect(result.trace.intent).toBe("unclear");
    expect(result.trace.resolvedIntent).toBe("check_availability");
    expect(result.trace.extracted).toMatchObject({
      productKeywords: ["mayonesa"],
      size: "grande"
    });
    expect(result.responseText).toContain("Mayonesa");
    expect(result.responseText).toContain("Como alternativa");
  });

  it("still asks a broad follow-up when no product or delivery signal is detected", async () => {
    const result = await orchestrateInboundMessage(message("Hola"));

    expect(result.shouldSend).toBe(true);
    expect(result.trace.intent).toBe("unclear");
    expect(result.trace.resolvedIntent).toBe("unclear");
    expect(result.responseText).toContain("disponibilidad");
  });

  it("runs the mocked delivery pipeline and returns an estimate caveat", async () => {
    const result = await orchestrateInboundMessage(message("Cuanto tarda el envio a Bogota?"));

    expect(result.shouldSend).toBe(true);
    expect(result.trace.intent).toBe("delivery_guidance");
    expect(result.responseText).toContain("1-2 dias habiles");
    expect(result.responseText).toContain("estimacion");
  });

});

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
