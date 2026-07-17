import { describe, expect, it } from "vitest";
import { getDeliveryGuidance, parseDeliveryRatesFromCalculatorHtml } from "./deliveryGuidance.js";

describe("getDeliveryGuidance", () => {
  const calculatorHtml = `
    <script>
      const shippingRatesByDepartment = {
        "Bogota D.C.": [
          {
            "city": "✅ Llega HOY - BOGOTA - Mejor PRECIO",
            "fee": 12000,
            "currency": "COP",
            "eta": "Llega hoy a toda Bogota",
            "methodId": "gid://shopify/DeliveryMethodDefinition/1073329537300"
          }
        ],
        "Córdoba": [
          {
            "city": "Planeta Rica",
            "fee": 28000,
            "currency": "COP",
            "eta": "Entrega estimada: 2 días hábiles",
            "methodId": "gid://shopify/DeliveryMethodDefinition/1074016420116"
          }
        ]
      };
      const textCollator = new Intl.Collator("es", { sensitivity: "base" });
    </script>
  `;

  it("returns Bogota delivery quote from the public calculator data shape", async () => {
    await expect(
      getDeliveryGuidance(
        { departmentText: "Bogota", cityText: "Bogota" },
        { fetchHtml: async () => calculatorHtml }
      )
    ).resolves.toMatchObject({
      source: "public_shopify_delivery_calculator",
      priceCop: 12000,
      needsCity: false,
      needsDepartment: false,
      summary: expect.stringContaining("$12.000 COP")
    });
  });

  it("returns national delivery quote for known department and city", async () => {
    await expect(
      getDeliveryGuidance(
        { departmentText: "Cordoba", cityText: "Planeta Rica" },
        { fetchHtml: async () => calculatorHtml }
      )
    ).resolves.toMatchObject({
      source: "public_shopify_delivery_calculator",
      priceCop: 28000,
      needsCity: false,
      needsDepartment: false,
      summary: expect.stringContaining("2 días hábiles")
    });
  });

  it("parses the embedded calculator rate table", () => {
    expect(parseDeliveryRatesFromCalculatorHtml(calculatorHtml)).toMatchObject({
      "Córdoba": [
        {
          city: "Planeta Rica",
          fee: 28000
        }
      ]
    });
  });

  it("asks for department and city when location is unknown", async () => {
    await expect(getDeliveryGuidance({})).resolves.toMatchObject({
      needsDepartment: true,
      needsCity: true
    });
  });

  it("asks for city when only department is known", async () => {
    await expect(getDeliveryGuidance({ departmentText: "Antioquia" })).resolves.toMatchObject({
      needsDepartment: false,
      needsCity: true
    });
  });
});
