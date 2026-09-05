import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/env.js";
import { createInternalMcpLocalRuntime } from "./localRuntime.js";

describe("internal MCP local runtime", () => {
  const config = loadConfig({ NODE_ENV: "test", PORT: "3200" });
  const runtime = createInternalMcpLocalRuntime(config);

  it("reports the internal MCP as active while production capabilities remain disconnected", async () => {
    const response = await runtime.fetch(new Request("http://localhost:3200/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      ok: true,
      activeProvider: "internal_mcp",
      defaultProvider: "internal_mcp",
      oauthVerifierConfigured: false,
      conversationPersistenceConfigured: false,
      outboundMessagingConfigured: false,
      legacyTwilioEnabled: false
    }));
  });

  it("serves protected-resource discovery from the selected local MCP origin", async () => {
    const response = await runtime.fetch(new Request(
      "http://localhost:3200/.well-known/oauth-protected-resource"
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      resource: "http://localhost:3200",
      authorization_servers: ["https://auth.automatedandco.danienremoto.com"],
      bearer_methods_supported: ["header"]
    }));
  });

  it("keeps token-in-URL rejection active on the default runtime", async () => {
    const response = await runtime.fetch(new Request(
      "http://localhost:3200/mcp?access_token=forbidden",
      { method: "POST" }
    ));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Tokens in URLs are forbidden");
  });
});
