import { describe, expect, it } from "vitest";
import { readWhatsAppSandboxConfig, sandboxRecipientAllowed } from "./sandboxConfig.js";

describe("WhatsApp sandbox configuration", () => {
  it("fails closed for partial or unsafe configuration", () => {
    expect(readWhatsAppSandboxConfig({})).toBeNull();
    expect(() => readWhatsAppSandboxConfig({ META_SANDBOX_TENANT_ID: "sandbox" })).toThrow(/incomplete/);
    expect(() => readWhatsAppSandboxConfig({
      META_SANDBOX_TENANT_ID: "sandbox",
      META_SANDBOX_WABA_ID: "123456",
      META_SANDBOX_PHONE_NUMBER_ID: "654321",
      META_SANDBOX_ACCESS_TOKEN: "a".repeat(30),
      META_SANDBOX_ALLOWED_RECIPIENTS: "not-a-number"
    })).toThrow(/recipients/);
  });

  it("normalizes a bounded allowlist and restricts only the sandbox tenant", () => {
    const config = readWhatsAppSandboxConfig({
      META_SANDBOX_TENANT_ID: "automated-co-sandbox",
      META_SANDBOX_WABA_ID: "5550002001",
      META_SANDBOX_PHONE_NUMBER_ID: "5550001001",
      META_SANDBOX_ACCESS_TOKEN: "token_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      META_SANDBOX_ALLOWED_RECIPIENTS: "+15550000001,15550000001"
    });
    expect(config?.allowedRecipients).toEqual(["15550000001"]);
    expect(sandboxRecipientAllowed(config, "automated-co-sandbox", "15550000001")).toBe(true);
    expect(sandboxRecipientAllowed(config, "automated-co-sandbox", "15550000002")).toBe(false);
    expect(sandboxRecipientAllowed(config, "client-one", "15550000002")).toBe(true);
  });
});
