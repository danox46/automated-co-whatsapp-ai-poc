import { describe, expect, it } from "vitest";
import { opaqueInstallationRef } from "./installationIdentity.js";

describe("opaque installation identity", () => {
  it("is stable for credential refresh, but separates tenants, assets and reference secrets", async () => {
    const input = ["client-a", "1234567", "2345678", "synthetic-reference-secret"] as const;
    const original = await opaqueInstallationRef(...input);
    expect(original).toMatch(/^inst_[A-Za-z0-9_-]{32}$/u);
    expect(await opaqueInstallationRef(...input)).toBe(original);
    for (let index = 0; index < input.length; index++) {
      const changed = [...input] as [string, string, string, string];
      changed[index] += "-changed";
      expect(await opaqueInstallationRef(...changed)).not.toBe(original);
    }
    expect(original).not.toMatch(/client-a|1234567|2345678/);
  });
});
