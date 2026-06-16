import { describe, expect, it } from "vitest";
import { MockInventoryProvider } from "./mockInventoryProvider.js";

describe("MockInventoryProvider", () => {
  const provider = new MockInventoryProvider();

  it("matches an available grocery package", async () => {
    const matches = await provider.findAvailability({
      searchText: "Tienen arroz de 5kg?",
      productKeywords: ["arroz"],
      size: "5kg"
    });

    expect(matches[0]).toMatchObject({
      productName: "Arroz",
      variantLabel: "bolsa 5kg",
      available: true,
      quantityAvailable: 4,
      advisoryRole: "requested"
    });
  });

  it("returns alternatives when requested package is unavailable", async () => {
    const matches = await provider.findAvailability({
      searchText: "Tienen mayonesa grande?",
      productKeywords: ["mayonesa"],
      size: "grande"
    });

    expect(matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productName: "Mayonesa",
          variantLabel: "frasco grande 900g",
          available: false,
          advisoryRole: "requested"
        }),
        expect.objectContaining({
          productName: "Mayonesa",
          variantLabel: "frasco mediano 450g",
          available: true,
          advisoryRole: "alternative",
          advisoryText: expect.stringContaining("cubrir 1 grande")
        })
      ])
    );
  });

  it("does not expose unrelated product alternatives", async () => {
    const matches = await provider.findAvailability({
      searchText: "Tienen atun pack x6?",
      productKeywords: ["atun"],
      size: "pack x6"
    });

    expect(new Set(matches.map((match) => match.productName))).toEqual(new Set(["Atun en lata"]));
  });
});
