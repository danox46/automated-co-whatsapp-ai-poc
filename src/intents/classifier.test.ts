import { describe, expect, it } from "vitest";
import { classifyIntent } from "./classifier.js";
import type { InboundMessage } from "../messages/types.js";

describe("classifyIntent", () => {
  it("detects availability questions", async () => {
    await expect(classifyIntent(message("Tienen mayonesa grande?"))).resolves.toBe(
      "check_availability"
    );
  });

  it("detects singular availability questions", async () => {
    await expect(classifyIntent(message("Tienes mayonesa grande?"))).resolves.toBe(
      "check_availability"
    );
  });

  it("detects delivery guidance questions", async () => {
    await expect(classifyIntent(message("Cuanto tarda el envio a Bogota?"))).resolves.toBe(
      "delivery_guidance"
    );
  });

  it("returns unclear for unsupported text", async () => {
    await expect(classifyIntent(message("Hola"))).resolves.toBe("unclear");
  });
});

function message(body: string): InboundMessage {
  return {
    provider: "twilio_whatsapp",
    body,
    receivedAt: new Date().toISOString(),
    raw: {}
  };
}
