import { describe, expect, it } from "vitest";
import { extractFields } from "./extractFields.js";

describe("extractFields", () => {
  it("extracts grocery product and package size", () => {
    expect(extractFields("Tienen mayonesa grande?")).toEqual({
      productKeywords: ["mayonesa"],
      requestedQuantity: undefined,
      size: "grande",
      city: undefined
    });
  });

  it("extracts requested quantities for grocery items", () => {
    expect(extractFields("Necesito 2 frascos de mayonesa grande")).toMatchObject({
      productKeywords: ["mayonesa"],
      requestedQuantity: 2,
      size: "grande"
    });
  });

  it("extracts weight and volume package sizes", () => {
    expect(extractFields("Tienen arroz de 5kg?")).toMatchObject({
      productKeywords: ["arroz"],
      size: "5kg"
    });
  });

  it("extracts normalized city names", () => {
    expect(extractFields("Cuanto tarda el envio a Bogotá?")).toMatchObject({
      city: "bogota"
    });
  });
});
