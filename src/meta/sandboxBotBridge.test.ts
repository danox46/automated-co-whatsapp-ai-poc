import { describe, expect, it, vi } from "vitest";
import { createSandboxBotBridge } from "./sandboxBotBridge.js";
import type { DurableConversationNamespace } from "../mcp/durableConversationStore.js";
import type { WhatsAppMessagingCapability } from "../mcp/outboundPolicy.js";

const ref = `conv_${"a".repeat(32)}`;
const origin = "https://mcp.example.test";
const sandbox = { tenantId: "owner-sandbox", wabaId: "123", phoneNumberId: "456", accessToken: "unused", allowedRecipients: ["573001234567"] };

function fixture(lastInboundAt = "2026-09-30T19:00:00.000Z") {
  const listConversations = vi.fn(async () => ({ conversations: [{ conversationRef: ref }] }));
  const getConversationHistory = vi.fn(async () => ({ conversation: { conversationRef: ref }, messages: [] }));
  const getByName = vi.fn(() => ({ initializeTenant: vi.fn(async () => undefined), listConversations, getConversationHistory }));
  const dispatchReplyWithPolicy = vi.fn(async () => ({ messageRef: "wamid.test", status: "accepted" as const }));
  const messaging = {
    guaranteesDurableIdempotency: true,
    now: () => new Date("2026-09-30T19:01:00.000Z"),
    resolveConversation: vi.fn(async () => ({ canonicalConversationRef: ref, providerParticipantRef: "573001234567",
      policyRevision: "v1", lastVerifiedUserInboundAt: lastInboundAt, recipientOptedOut: false,
      automationPaused: false, consentedTemplateCategories: new Set<string>(),
      consentedTemplatePurposes: new Set<string>(), approvedTemplates: [] })),
    validateOutboundContent: vi.fn(async () => ({ allowed: true as const })),
    dispatchReplyWithPolicy,
    dispatchTemplateWithPolicy: vi.fn()
  } as unknown as WhatsAppMessagingCapability;
  const bridge = createSandboxBotBridge({ token: "bridge-token", sandbox,
    conversations: { getByName } as unknown as DurableConversationNamespace, messaging, resource: origin });
  return { bridge, getByName, listConversations, getConversationHistory, dispatchReplyWithPolicy };
}

function request(path: string, method = "GET", body?: unknown, token = "bridge-token") {
  return new Request(`${origin}${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}

describe("sandbox bot bridge", () => {
  it("rejects unauthorized reads and confines queries to the configured sandbox tenant", async () => {
    const f = fixture();
    expect((await f.bridge(request("/bot/sandbox/conversations", "GET", undefined, "wrong")))?.status).toBe(401);
    expect(f.getByName).not.toHaveBeenCalled();
    const list = await f.bridge(request("/bot/sandbox/conversations"));
    expect(list?.status).toBe(200);
    expect(f.getByName).toHaveBeenCalledWith("owner-sandbox");
    const history = await f.bridge(request(`/bot/sandbox/conversations/${ref}/history`));
    expect(history?.status).toBe(200);
    expect(f.getConversationHistory).toHaveBeenCalledWith({ conversationRef: ref, limit: 100 });
    expect((await f.bridge(request("/bot/sandbox/conversations/other/history")))?.status).toBe(404);
  });

  it("routes one bounded reply through the existing 24-hour policy and provider idempotency", async () => {
    const f = fixture();
    const result = await f.bridge(request(`/bot/sandbox/conversations/${ref}/replies`, "POST",
      { text: "Hola", idempotencyKey: "sandbox-run-1" }));
    expect(result?.status).toBe(200);
    expect(f.dispatchReplyWithPolicy).toHaveBeenCalledWith(expect.objectContaining({
      text: "Hola", idempotencyKey: "sandbox-run-1", notAfter: "2026-10-01T19:00:00.000Z"
    }));
  });

  it("blocks a closed service window before provider dispatch", async () => {
    const f = fixture("2026-09-29T18:00:00.000Z");
    const result = await f.bridge(request(`/bot/sandbox/conversations/${ref}/replies`, "POST",
      { text: "Hola", idempotencyKey: "sandbox-run-2" }));
    expect(result?.status).toBe(409);
    expect(f.dispatchReplyWithPolicy).not.toHaveBeenCalled();
  });

  it("lists only sanitized Flows for the configured sandbox WABA", async () => {
    const f = fixture();
    const listFlows = vi.fn(async () => [{ id: "123456", name: "Visita sandbox", status: "PUBLISHED" }]);
    const bridge = createSandboxBotBridge({ token: "bridge-token", sandbox,
      conversations: { getByName: f.getByName } as unknown as DurableConversationNamespace,
      messaging: {} as WhatsAppMessagingCapability, resource: origin, listFlows });
    expect((await bridge(request("/bot/sandbox/flows", "GET", undefined, "wrong")))?.status).toBe(401);
    expect(listFlows).not.toHaveBeenCalled();
    const response = await bridge(request("/bot/sandbox/flows"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, flows: [{ id: "123456", name: "Visita sandbox", status: "PUBLISHED" }] });
    expect(f.getByName).not.toHaveBeenCalled();
  });
});
