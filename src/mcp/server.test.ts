import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createProtectedWhatsAppMcpHandler } from "./server.js";
import type { WhatsAppMessagingCapability } from "./outboundPolicy.js";
import {
  InMemoryWhatsAppConversationStore,
  type WhatsAppConversationReader
} from "./conversationHistory.js";

const resource = "https://auth.automatedandco.danienremoto.com";

function createAuthorizedHandler(
  messaging?: WhatsAppMessagingCapability,
  conversationReader?: WhatsAppConversationReader
) {
  return createProtectedWhatsAppMcpHandler({
    resource,
    authorizationServer: resource,
    verifyToken: async (token) => {
      if (token === "valid-test-token") {
        return {
          subject: "test-owner",
          tenantId: "tenant_1",
          audience: resource,
          scopes: new Set(["whatsapp.policy.read", "whatsapp.connection.read", "whatsapp.conversations.read", "whatsapp.messages.send"])
        };
      }
      if (token === "policy-only-token") {
        return {
          subject: "test-owner",
          tenantId: "tenant_1",
          audience: resource,
          scopes: new Set(["whatsapp.policy.read"])
        };
      }
      return null;
    },
    messaging,
    conversationReader
  });
}

function closedWindowMessaging(): WhatsAppMessagingCapability {
  return {
    guaranteesDurableIdempotency: false,
    resolveConversation: async () => ({
      canonicalConversationRef: "tenant_1:conversation_123",
      policyRevision: "revision_1",
      lastVerifiedUserInboundAt: "2026-09-04T12:00:00.000Z",
      recipientOptedOut: false,
      automationPaused: false,
      consentedTemplateCategories: new Set(["utility"]),
      consentedTemplatePurposes: new Set(["order_status"]),
      approvedTemplates: [{ name: "order_update", category: "utility", purpose: "order_status", enabled: true }]
    }),
    validateOutboundContent: async () => ({ allowed: true }),
    dispatchReplyWithPolicy: async () => ({ messageRef: "reply_1", status: "accepted" }),
    dispatchTemplateWithPolicy: async () => ({ messageRef: "template_1", status: "accepted" }),
    now: () => new Date("2026-09-05T12:00:00.000Z")
  };
}

describe("protected WhatsApp MCP handler", () => {
  it("publishes protected-resource metadata for OAuth discovery", async () => {
    const response = await createAuthorizedHandler().fetch(new Request(`${resource}/.well-known/oauth-protected-resource`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource,
      authorization_servers: [resource],
      scopes_supported: ["whatsapp.policy.read", "whatsapp.connection.read", "whatsapp.conversations.read", "whatsapp.messages.send"],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://automatedandco.danienremoto.com/mcp/whatsapp/",
      resource_policy_uri: "https://automatedandco.danienremoto.com/mcp/whatsapp/privacidad/",
      resource_tos_uri: "https://automatedandco.danienremoto.com/mcp/whatsapp/terminos/"
    });
  });

  it("lists tool metadata without a token but fails closed at invocation with an OAuth challenge", async () => {
    const handler = createAuthorizedHandler();
    const client = new Client({ name: "unauthenticated-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${resource}/mcp`), {
      fetch: (url, init) => handler.fetch(new Request(url, init))
    });

    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(3);
    const result = await client.callTool({ name: "whatsapp_get_policy", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('error="invalid_token"')
    ]);
    await client.close();
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

    const expectedScopes: Record<string, string[]> = {
      whatsapp_evaluate_action: ["whatsapp.policy.read"],
      whatsapp_get_connection_status: ["whatsapp.connection.read"],
      whatsapp_get_policy: ["whatsapp.policy.read"]
    };
    for (const tool of tools.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      });
      expect(tool.outputSchema).toBeDefined();
      expect(tool._meta?.securitySchemes).toEqual([
        { type: "oauth2", scopes: expectedScopes[tool.name] }
      ]);
    }

    const policy = await client.callTool({ name: "whatsapp_get_policy", arguments: {} });
    expect(policy.structuredContent).toMatchObject({
      retention: {
        messageContentDays: 90,
        inactiveConversationDays: 365,
        unmatchedDeliveryStatusDays: 7,
        pruneIntervalHours: 24,
        optOutSuppression: "while_connection_active_or_until_authenticated_deletion"
      }
    });

    const runtimeCheck = await client.callTool({
      name: "whatsapp_evaluate_action",
      arguments: { action: "start_conversation" }
    });
    const runtimeCheckText = (runtimeCheck.content[0] as { text: string }).text;
    expect(JSON.parse(runtimeCheckText)).toMatchObject({
      allowed: null,
      action: "start_conversation",
      status: "runtime_check_required"
    });
    expect(runtimeCheck.structuredContent).toBeDefined();
    await client.close();
  });

  it("advertises top-level per-tool OAuth security schemes on the raw wire response", async () => {
    const handler = createAuthorizedHandler(closedWindowMessaging(), new InMemoryWhatsAppConversationStore());
    const advertisedTools = new Map<string, unknown>();
    const client = new Client({ name: "wire-metadata-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${resource}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer valid-test-token" } },
      fetch: async (url, init) => {
        const response = await handler.fetch(new Request(url, init));
        const contentType = response.headers.get("content-type") ?? "";
        const payloads: Array<{
          result?: { tools?: Array<{ name: string; securitySchemes?: unknown }> };
        }> = [];
        if (contentType.includes("application/json")) {
          payloads.push(await response.clone().json() as {
            result?: { tools?: Array<{ name: string; securitySchemes?: unknown }> };
          });
        } else if (contentType.includes("text/event-stream")) {
          for (const line of (await response.clone().text()).split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            payloads.push(JSON.parse(line.slice(5).trim()) as {
              result?: { tools?: Array<{ name: string; securitySchemes?: unknown }> };
            });
          }
        }
        for (const payload of payloads) {
          for (const tool of payload.result?.tools ?? []) {
            advertisedTools.set(tool.name, tool.securitySchemes);
          }
        }
        return response;
      }
    });

    await client.connect(transport);
    await client.listTools();
    expect(Object.fromEntries(advertisedTools)).toEqual({
      whatsapp_evaluate_action: [{ type: "oauth2", scopes: ["whatsapp.policy.read"] }],
      whatsapp_get_connection_status: [{ type: "oauth2", scopes: ["whatsapp.connection.read"] }],
      whatsapp_get_conversation_history: [{ type: "oauth2", scopes: ["whatsapp.conversations.read"] }],
      whatsapp_get_policy: [{ type: "oauth2", scopes: ["whatsapp.policy.read"] }],
      whatsapp_list_conversations: [{ type: "oauth2", scopes: ["whatsapp.conversations.read"] }],
      whatsapp_reply_to_inbound: [{ type: "oauth2", scopes: ["whatsapp.messages.send"] }],
      whatsapp_send_template: [{ type: "oauth2", scopes: ["whatsapp.messages.send"] }]
    });
    await client.close();
  });

  it("returns an actionable insufficient-scope challenge without running the tool", async () => {
    const handler = createAuthorizedHandler();
    const client = new Client({ name: "scope-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${resource}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer policy-only-token" } },
      fetch: (url, init) => handler.fetch(new Request(url, init))
    });

    await client.connect(transport);
    const result = await client.callTool({ name: "whatsapp_get_connection_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('error="insufficient_scope"')
    ]);
    expect(result._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining("whatsapp.connection.read")
    ]);
    await client.close();
  });

  it("exposes tenant-scoped conversation history only through structured read results", async () => {
    const store = new InMemoryWhatsAppConversationStore(
      () => new Date("2026-09-05T12:00:00.000Z")
    );
    await store.ingestMessage({
      tenantId: "tenant_1",
      providerAccountRef: "internal-account",
      providerParticipantRef: "internal-recipient",
      conversationRef: "conv_safe_reference",
      messageRef: "message_1",
      direction: "inbound",
      kind: "text",
      text: "Private customer question",
      occurredAt: "2026-09-05T11:00:00.000Z",
      status: "received"
    });
    await store.ingestMessage({
      tenantId: "different_tenant",
      providerAccountRef: "other-account",
      providerParticipantRef: "other-recipient",
      conversationRef: "conv_other_tenant",
      messageRef: "message_other",
      direction: "inbound",
      kind: "text",
      text: "Must remain isolated",
      occurredAt: "2026-09-05T11:30:00.000Z",
      status: "received"
    });

    const handler = createAuthorizedHandler(undefined, store);
    const client = new Client({ name: "history-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${resource}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer valid-test-token" } },
      fetch: (url, init) => handler.fetch(new Request(url, init))
    });
    await client.connect(transport);

    const tools = await client.listTools();
    for (const toolName of ["whatsapp_list_conversations", "whatsapp_get_conversation_history"]) {
      const tool = tools.tools.find((candidate) => candidate.name === toolName);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      });
      expect(tool?.outputSchema).toBeDefined();
      expect(tool?._meta?.securitySchemes).toEqual([
        { type: "oauth2", scopes: ["whatsapp.conversations.read"] }
      ]);
    }

    const list = await client.callTool({ name: "whatsapp_list_conversations", arguments: {} });
    expect((list.content[0] as { text: string }).text).not.toContain("Private customer question");
    expect(list.structuredContent).toMatchObject({
      conversations: [{ conversationRef: "conv_safe_reference" }]
    });
    expect(JSON.stringify(list.structuredContent)).not.toContain("conv_other_tenant");

    const history = await client.callTool({
      name: "whatsapp_get_conversation_history",
      arguments: { conversationRef: "conv_safe_reference" }
    });
    expect((history.content[0] as { text: string }).text).not.toContain("Private customer question");
    expect(history.structuredContent).toMatchObject({
      found: true,
      messages: [{ messageRef: "message_1", text: "Private customer question" }]
    });
    await client.close();

    const underScopedClient = new Client({ name: "history-scope-test", version: "1.0.0" });
    const underScopedTransport = new StreamableHTTPClientTransport(new URL(`${resource}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer policy-only-token" } },
      fetch: (url, init) => handler.fetch(new Request(url, init))
    });
    await underScopedClient.connect(underScopedTransport);
    const blocked = await underScopedClient.callTool({
      name: "whatsapp_list_conversations",
      arguments: {}
    });
    expect(blocked.isError).toBe(true);
    expect(blocked._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining("whatsapp.conversations.read")
    ]);
    await underScopedClient.close();
  });

  it("registers provider-backed reply and approved-template tools when messaging is configured", async () => {
    const handler = createAuthorizedHandler(closedWindowMessaging());
    const client = new Client({ name: "messaging-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${resource}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer valid-test-token" } },
      fetch: (url, init) => handler.fetch(new Request(url, init))
    });

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "whatsapp_evaluate_action",
      "whatsapp_get_connection_status",
      "whatsapp_get_policy",
      "whatsapp_reply_to_inbound",
      "whatsapp_send_template"
    ]);
    for (const toolName of ["whatsapp_reply_to_inbound", "whatsapp_send_template"]) {
      const tool = tools.tools.find((candidate) => candidate.name === toolName);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false
      });
      expect(tool?.outputSchema).toBeDefined();
      expect(tool?._meta?.securitySchemes).toEqual([
        { type: "oauth2", scopes: ["whatsapp.messages.send"] }
      ]);
    }

    const blockedReply = await client.callTool({
      name: "whatsapp_reply_to_inbound",
      arguments: {
        conversationRef: "conversation_123",
        text: "A late free-form reply",
        idempotencyKey: "reply:late:123"
      }
    });
    expect(blockedReply.isError).toBe(true);
    expect(JSON.parse((blockedReply.content[0] as { text: string }).text)).toMatchObject({
      ok: false,
      error: {
        code: "WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED",
        requiredAction: "approved_template_required",
        suggestedTool: "whatsapp_send_template"
      }
    });

    const template = await client.callTool({
      name: "whatsapp_send_template",
      arguments: {
        conversationRef: "conversation_123",
        templateName: "order_update",
        variables: [],
        idempotencyKey: "template:order:123"
      }
    });
    expect(template.isError).not.toBe(true);
    expect(JSON.parse((template.content[0] as { text: string }).text)).toMatchObject({
      ok: true,
      messageRef: "template_1"
    });

    const hybridReply = await client.callTool({
      name: "whatsapp_reply_to_inbound",
      arguments: {
        conversationRef: "conversation_123",
        text: "A reply must not accept template fields.",
        templateName: "order_update",
        idempotencyKey: "reply:hybrid:123"
      }
    });
    expect(hybridReply.isError).toBe(true);
    await client.close();
  });
});
