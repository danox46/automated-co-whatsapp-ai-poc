import { describe, expect, it } from "vitest";
import { getDeliveryGuidance } from "./deliveryGuidance.js";

describe("getDeliveryGuidance", () => {
  it("returns Bogota delivery estimate", async () => {
    await expect(getDeliveryGuidance({ destinationText: "Bogota" })).resolves.toMatchObject({
      destinationType: "bogota",
      needsCity: false,
      summary: expect.stringContaining("1-2 dias habiles")
    });
  });

  it("returns national delivery estimate for known non-Bogota cities", async () => {
    await expect(getDeliveryGuidance({ destinationText: "Medellin" })).resolves.toMatchObject({
      destinationType: "national",
      needsCity: false,
      summary: expect.stringContaining("3-5 dias habiles")
    });
  });

  it("asks for city when location is unknown", async () => {
    await expect(getDeliveryGuidance({})).resolves.toMatchObject({
      destinationType: "unknown",
      needsCity: true
    });
  });
});
