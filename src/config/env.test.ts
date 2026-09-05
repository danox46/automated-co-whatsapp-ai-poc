import { describe, expect, it } from "vitest";
import { loadConfig, validateRuntimeConfig } from "./env.js";

describe("WhatsApp runtime selection", () => {
  it("defaults new runtime work to the internal MCP without requiring Twilio credentials", () => {
    const config = loadConfig({ NODE_ENV: "test", PORT: "3100" });

    expect(config.whatsappProvider).toBe("internal_mcp");
    expect(config.mcp.resource).toBe("http://localhost:3100");
    expect(validateRuntimeConfig(config)).toEqual({ ok: true, missing: [] });
  });

  it("requires explicit Twilio credentials only when the legacy runtime is selected", () => {
    const incomplete = loadConfig({
      NODE_ENV: "test",
      WHATSAPP_PROVIDER: "legacy_twilio"
    });

    expect(validateRuntimeConfig(incomplete)).toEqual({
      ok: false,
      missing: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"]
    });

    const complete = loadConfig({
      NODE_ENV: "test",
      WHATSAPP_PROVIDER: "legacy_twilio",
      TWILIO_ACCOUNT_SID: "test-account",
      TWILIO_AUTH_TOKEN: "test-token",
      TWILIO_WHATSAPP_FROM: "whatsapp:+10000000000"
    });

    expect(validateRuntimeConfig(complete)).toEqual({ ok: true, missing: [] });
  });
});
