import { describe, expect, it } from "vitest";
import { extractFields } from "./extractFields.js";

describe("extractFields", () => {
  it("extracts grocery product and package size", () => {
    expect(extractFields("Tienen canelitas pack x3?")).toEqual({
      productKeywords: ["canelitas"],
      requestedQuantity: undefined,
      size: "pack x3",
      department: undefined,
      city: undefined
    });
  });

  it("extracts requested quantities for grocery items", () => {
    expect(extractFields("Necesito 2 maltas Riko Malt 500ml")).toMatchObject({
      productKeywords: ["riko malt"],
      requestedQuantity: 2,
      size: "500ml"
    });
  });

  it("extracts weight and volume package sizes", () => {
    expect(extractFields("Tienen diablitos de 54g?")).toMatchObject({
      productKeywords: ["diablitos"],
      size: "54g"
    });
  });

  it("extracts normalized city names", () => {
    expect(extractFields("Cuanto tarda el envio a Bogotá?")).toMatchObject({
      department: "bogota",
      city: "bogota"
    });
  });

  it("extracts department and city for delivery calculator questions", () => {
    expect(extractFields("Cuanto cuesta el domicilio a Medellin, Antioquia?")).toMatchObject({
      department: "antioquia",
      city: "medellin"
    });
  });

  it("extracts Planeta Rica delivery location", () => {
    expect(extractFields("Cuanto para planeta Rica?")).toMatchObject({
      department: "cordoba",
      city: "planeta rica"
    });
  });
});
