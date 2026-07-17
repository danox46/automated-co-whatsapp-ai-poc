import { describe, expect, it } from "vitest";
import { MockInventoryProvider } from "./mockInventoryProvider.js";

describe("MockInventoryProvider", () => {
  const provider = new MockInventoryProvider();

  it("matches an available grocery package", async () => {
    const matches = await provider.findAvailability({
      searchText: "Tienen diablitos de 54g?",
      productKeywords: ["diablitos"],
      size: "54g"
    });

    expect(matches[0]).toMatchObject({
      productName: "Diablitos Underwood",
      variantLabel: "54g x 24 unidades",
      available: true,
      quantityAvailable: 8,
      advisoryRole: "requested"
    });
  });

  it("returns alternatives when requested package is unavailable", async () => {
    const matches = await provider.findAvailability({
      searchText: "Tienen canelitas pack x3?",
      productKeywords: ["canelitas"],
      size: "pack x3"
    });

    expect(matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productName: "Canelitas Marinela",
          variantLabel: "pack x 3 unidades",
          available: false,
          advisoryRole: "requested"
        }),
        expect.objectContaining({
          productName: "Canelitas Marinela",
          variantLabel: "paquete individual",
          available: true,
          advisoryRole: "alternative",
          advisoryText: expect.stringContaining("cubrir 1 pack x3")
        })
      ])
    );
  });

  it("does not expose unrelated product alternatives", async () => {
    const matches = await provider.findAvailability({
      searchText: "Tienen golden manzanita pack x6?",
      productKeywords: ["golden manzanita"],
      size: "pack x6"
    });

    expect(new Set(matches.map((match) => match.productName))).toEqual(
      new Set(["Golden Manzanita lata 355 Ml Venezuela"])
    );
  });
});
