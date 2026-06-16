import { describe, expect, it } from "vitest";
import { composeResponse } from "./composeResponse.js";

describe("composeResponse", () => {
  it("confirms availability without exposing exact mock stock counts", () => {
    const response = composeResponse({
      intent: "check_availability",
      extracted: { productKeywords: ["arroz"], size: "5kg" },
      inventory: [
        {
          productId: "prod_arroz",
          productName: "Arroz",
          variantLabel: "bolsa 5kg",
          available: true,
          quantityAvailable: 4,
          requestedMatch: true,
          advisoryRole: "requested",
          productUrl: "https://automated.co/mock/arroz"
        }
      ]
    });

    expect(response).toContain("aparece disponible");
    expect(response).not.toContain("4");
  });

  it("offers a substitution when the requested grocery size is unavailable", () => {
    const response = composeResponse({
      intent: "check_availability",
      extracted: { productKeywords: ["mayonesa"], size: "grande" },
      inventory: [
        {
          productId: "prod_mayonesa",
          productName: "Mayonesa",
          variantLabel: "frasco grande 900g",
          available: false,
          quantityAvailable: 0,
          requestedMatch: true,
          advisoryRole: "requested",
          productUrl: "https://automated.co/mock/mayonesa"
        },
        {
          productId: "prod_mayonesa",
          productName: "Mayonesa",
          variantLabel: "frasco mediano 450g",
          available: true,
          quantityAvailable: 12,
          requestedMatch: false,
          advisoryRole: "alternative",
          advisoryText: "Como alternativa, puedes pedir 2 frascos medianos 450g para cubrir 1 grande.",
          productUrl: "https://automated.co/mock/mayonesa"
        }
      ]
    });

    expect(response).toContain("no aparece disponible");
    expect(response).toContain("Como alternativa");
    expect(response).toContain("Te serviria");
    expect(response).not.toContain("12");
  });

  it("adds an upsell only after the requested item is available", () => {
    const response = composeResponse({
      intent: "check_availability",
      extracted: { productKeywords: ["arroz"], size: "5kg" },
      inventory: [
        {
          productId: "prod_arroz",
          productName: "Arroz",
          variantLabel: "bolsa 5kg",
          available: true,
          quantityAvailable: 4,
          requestedMatch: true,
          advisoryRole: "requested",
          productUrl: "https://automated.co/mock/arroz"
        },
        {
          productId: "prod_arroz",
          productName: "Arroz",
          variantLabel: "bolsa 1kg",
          available: true,
          quantityAvailable: 16,
          requestedMatch: false,
          advisoryRole: "upsell",
          advisoryText: "Si es para la semana, tambien tenemos frijol rojo 1kg.",
          productUrl: "https://automated.co/mock/arroz"
        }
      ]
    });

    expect(response).toContain("aparece disponible");
    expect(response).toContain("tambien tenemos");
  });

  it("does not promise exact delivery dates", () => {
    const response = composeResponse({
      intent: "delivery_guidance",
      extracted: { productKeywords: [], city: "bogota" },
      deliveryGuidance: {
        destinationType: "bogota",
        summary: "A Bogota el envio suele tardar 1-2 dias habiles.",
        caveats: ["Es una estimacion, no una fecha exacta garantizada."],
        needsCity: false
      }
    });

    expect(response).toContain("estimacion");
    expect(response).not.toContain("garantizamos");
  });
});
