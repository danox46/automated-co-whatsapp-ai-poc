import { describe, expect, it } from "vitest";
import { composeResponse } from "./composeResponse.js";

describe("composeResponse", () => {
  it("confirms availability without exposing exact mock stock counts", () => {
    const response = composeResponse({
      intent: "check_availability",
      extracted: { productKeywords: ["diablitos"], size: "54g" },
      inventory: [
        {
          productId: "prod_diablitos_underwood",
          productName: "Diablitos Underwood",
          variantLabel: "54g x 24 unidades",
          available: true,
          quantityAvailable: 8,
          requestedMatch: true,
          advisoryRole: "requested",
          productUrl: "https://elportalvenezolano.com/products/diablitos"
        }
      ]
    });

    expect(response).toContain("aparece disponible");
    expect(response).not.toContain("8 disponibles");
  });

  it("offers a substitution when the requested grocery size is unavailable", () => {
    const response = composeResponse({
      intent: "check_availability",
      extracted: { productKeywords: ["canelitas"], size: "pack x3" },
      inventory: [
        {
          productId: "prod_canelitas",
          productName: "Canelitas Marinela",
          variantLabel: "pack x 3 unidades",
          available: false,
          quantityAvailable: 0,
          requestedMatch: true,
          advisoryRole: "requested",
          productUrl: "https://elportalvenezolano.com/products/canelitas-marinela-galletas-venezolanas"
        },
        {
          productId: "prod_canelitas",
          productName: "Canelitas Marinela",
          variantLabel: "paquete individual",
          available: true,
          quantityAvailable: 9,
          requestedMatch: false,
          advisoryRole: "alternative",
          advisoryText:
            "Como alternativa, puedes pedir 3 paquetes individuales para cubrir 1 pack x3.",
          productUrl: "https://elportalvenezolano.com/products/canelitas-marinela-galletas-venezolanas"
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
      extracted: { productKeywords: ["riko malt"], size: "500ml" },
      inventory: [
        {
          productId: "prod_riko_malt",
          productName: "Riko Malt 500Ml Venezuela",
          variantLabel: "botella 500ml",
          available: true,
          quantityAvailable: 10,
          requestedMatch: true,
          advisoryRole: "requested",
          productUrl: "https://elportalvenezolano.com/products/riko-malt-500ml-venezuela"
        },
        {
          productId: "prod_riko_malt",
          productName: "Riko Malt 500Ml Venezuela",
          variantLabel: "500ml x 3 unidades",
          available: true,
          quantityAvailable: 5,
          requestedMatch: false,
          advisoryRole: "upsell",
          advisoryText: "Tambien aparece la presentacion x 3 unidades.",
          productUrl: "https://elportalvenezolano.com/products/riko-malt-500ml-venezuela"
        }
      ]
    });

    expect(response).toContain("aparece disponible");
    expect(response).toContain("Tambien aparece");
  });

  it("does not promise exact delivery dates", () => {
    const response = composeResponse({
      intent: "delivery_guidance",
      extracted: { productKeywords: [], department: "bogota", city: "bogota" },
      deliveryGuidance: {
        source: "public_shopify_delivery_calculator",
        sourceUrl: "https://elportalvenezolano.com/products/diablitos?variant=50232260198676",
        department: "bogota",
        city: "bogota",
        zone: "Bogota urbana",
        priceCop: 12000,
        estimatedDelivery: "Llega hoy a toda Bogota",
        summary: "Para Bogota, el domicilio aparece en $12.000 COP y la entrega estimada es llega hoy a toda bogota.",
        caveats: ["Es una estimacion del calculador de domicilio, no una promesa exacta."],
        needsDepartment: false,
        needsCity: false
      }
    });

    expect(response).toContain("estimacion");
    expect(response).not.toContain("garantizamos");
  });
});
