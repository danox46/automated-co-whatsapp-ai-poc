import { describe, expect, it } from "vitest";
import { classifyIntent } from "./classifier.js";
import type { InboundMessage } from "../messages/types.js";

describe("classifyIntent", () => {
  it("detects availability questions", async () => {
    await expect(classifyIntent(message("Tienen Diablitos 54g?"))).resolves.toBe(
      "check_availability"
    );
  });

  it("detects singular availability questions", async () => {
    await expect(classifyIntent(message("Tienes Riko Malt 500ml?"))).resolves.toBe(
      "check_availability"
    );
  });

  it("detects delivery guidance questions", async () => {
    await expect(classifyIntent(message("Cuanto cuesta el domicilio a Bogota?"))).resolves.toBe(
      "delivery_guidance"
    );
  });

  it("detects natural delivery price shorthand", async () => {
    await expect(classifyIntent(message("Cuanto para planeta Rica?"))).resolves.toBe(
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
