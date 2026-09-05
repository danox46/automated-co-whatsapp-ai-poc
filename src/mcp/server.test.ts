import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createProtectedWhatsAppMcpHandler } from "./server.js";

const resource = "https://auth.automatedandco.danienremoto.com";

function createAuthorizedHandler() {
  return createProtectedWhatsAppMcpHandler({
    resource,
    authorizationServer: resource,
    verifyToken: async (token) => token === "valid-test-token" ? {
      subject: "test-owner",
      audience: resource,
      scopes: new Set(["whatsapp.policy.read", "whatsapp.connection.read"])
    } : null
  });
}

describe("protected WhatsApp MCP handler", () => {
  it("publishes protected-resource metadata for OAuth discovery", async () => {
    const response = await createAuthorizedHandler().fetch(new Request(`${resource}/.well-known/oauth-protected-resource`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource,
      authorization_servers: [resource],
      scopes_supported: ["whatsapp.policy.read", "whatsapp.connection.read"],
      bearer_methods_supported: ["header"]
    });
  });

  it("fails closed without a bearer token", async () => {
    const response = await createAuthorizedHandler().fetch(new Request(`${resource}/mcp`, { method: "POST" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
  });

  it("rejects tokens in query strings", async () => {
    const response = await createAuthorizedHandler().fetch(new Request(`${resource}/mcp?access_token=leak`, { method: "POST" }));
    expect(response.status).toBe(400);
  });

  it("lists only the approved read-only tools", async () => {
    const handler = createAuthorizedHandler();
    const client = new Client({ name: "policy-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${resource}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer valid-test-token" } },
      fetch: (url, init) => handler.fetch(new Request(url, init))
    });

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "whatsapp_evaluate_action",
      "whatsapp_get_connection_status",
      "whatsapp_get_policy"
    ]);

    const denied = await client.callTool({
      name: "whatsapp_evaluate_action",
      arguments: { action: "start_conversation" }
    });
    const deniedText = (denied.content[0] as { text: string }).text;
    expect(JSON.parse(deniedText)).toMatchObject({
      allowed: false,
      action: "start_conversation"
    });
    await client.close();
  });
});
