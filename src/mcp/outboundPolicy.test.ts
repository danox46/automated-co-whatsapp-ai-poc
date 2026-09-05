import { describe, expect, it, vi } from "vitest";
import type { WhatsAppMcpPrincipal } from "./auth.js";
import {
  dispatchApprovedTemplate,
  dispatchFreeFormReply,
  evaluateFreeFormReply,
  evaluateTemplateSend,
  type ResolvedWhatsAppConversation,
  type WhatsAppMessagingCapability
} from "./outboundPolicy.js";

const inboundAt = "2026-09-04T12:00:00.000Z";
const sendPrincipal: WhatsAppMcpPrincipal = {
  subject: "owner",
  tenantId: "tenant_1",
  audience: "https://auth.example.test",
  scopes: new Set(["whatsapp.policy.read", "whatsapp.connection.read", "whatsapp.messages.send"])
};

function conversation(
  overrides: Partial<ResolvedWhatsAppConversation> = {}
): ResolvedWhatsAppConversation {
  return {
    canonicalConversationRef: "tenant_1:conversation_123",
    policyRevision: "revision_1",
    lastVerifiedUserInboundAt: inboundAt,
    recipientOptedOut: false,
    automationPaused: false,
    consentedTemplateCategories: new Set(["utility"]),
    consentedTemplatePurposes: new Set(["order_status"]),
    approvedTemplates: [{ name: "order_update", category: "utility", purpose: "order_status", enabled: true }],
    ...overrides
  };
}

function capability(
  resolved: ResolvedWhatsAppConversation | null,
  now = new Date("2026-09-05T11:59:59.999Z")
): WhatsAppMessagingCapability & {
  dispatchReplyWithPolicy: ReturnType<typeof vi.fn>;
  dispatchTemplateWithPolicy: ReturnType<typeof vi.fn>;
} {
  return {
    guaranteesDurableIdempotency: false,
    resolveConversation: vi.fn(async () => resolved),
    validateOutboundContent: vi.fn(async () => ({ allowed: true as const })),
    dispatchReplyWithPolicy: vi.fn(async () => ({ messageRef: "message_1", status: "accepted" as const })),
    dispatchTemplateWithPolicy: vi.fn(async () => ({ messageRef: "message_2", status: "accepted" as const })),
    now: () => now
  };
}

describe("WhatsApp outbound policy", () => {
  it("allows a free-form reply until immediately before the 24-hour boundary", () => {
    expect(evaluateFreeFormReply(conversation(), new Date("2026-09-05T11:59:59.999Z"))).toMatchObject({
      allowed: true,
      code: "WHATSAPP_ACTION_ALLOWED"
    });
  });

  it("blocks a free-form reply at exactly 24 hours with a clear template alternative", () => {
    const decision = evaluateFreeFormReply(conversation(), new Date("2026-09-05T12:00:00.000Z"));
    expect(decision).toMatchObject({
      allowed: false,
      code: "WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED",
      requiredAction: "approved_template_required",
      suggestedTool: "whatsapp_send_template",
      windowClosedAt: "2026-09-05T12:00:00.000Z"
    });
    expect(decision.message).toContain("not because the MCP lacks capability");
    expect(decision.message).toContain("whatsapp_send_template");
  });

  it("blocks missing, malformed, and future inbound timestamps instead of inventing a window", () => {
    expect(evaluateFreeFormReply(conversation({ lastVerifiedUserInboundAt: null }), new Date())).toMatchObject({
      code: "WHATSAPP_NO_VERIFIED_USER_MESSAGE"
    });
    expect(evaluateFreeFormReply(conversation({ lastVerifiedUserInboundAt: "invalid" }), new Date())).toMatchObject({
      code: "WHATSAPP_INVALID_INBOUND_TIMESTAMP"
    });
    expect(evaluateFreeFormReply(
      conversation({ lastVerifiedUserInboundAt: "2026-09-05T12:00:01.000Z" }),
      new Date("2026-09-05T12:00:00.000Z")
    )).toMatchObject({ code: "WHATSAPP_INVALID_INBOUND_TIMESTAMP" });
  });

  it("allows an approved template outside the service window for a consented category", () => {
    expect(evaluateTemplateSend(conversation(), "order_update")).toMatchObject({
      allowed: true
    });
  });

  it("requires exact template-purpose consent even when the broad category is consented", () => {
    const context = conversation({
      approvedTemplates: [
        { name: "order_update", category: "utility", purpose: "order_status", enabled: true },
        { name: "account_notice", category: "utility", purpose: "account_notice", enabled: true }
      ]
    });
    expect(evaluateTemplateSend(context, "order_update")).toMatchObject({ allowed: true });
    expect(evaluateTemplateSend(context, "account_notice")).toMatchObject({
      allowed: false,
      code: "WHATSAPP_TEMPLATE_CONSENT_REQUIRED"
    });
  });

  it("blocks unapproved templates, missing category consent, opt-outs, and automation handoff", () => {
    expect(evaluateTemplateSend(conversation(), "unknown")).toMatchObject({
      code: "WHATSAPP_TEMPLATE_NOT_APPROVED"
    });
    expect(evaluateTemplateSend(conversation({ consentedTemplateCategories: new Set() }), "order_update")).toMatchObject({
      code: "WHATSAPP_TEMPLATE_CONSENT_REQUIRED"
    });
    expect(evaluateFreeFormReply(conversation({ recipientOptedOut: true }), new Date())).toMatchObject({
      code: "WHATSAPP_RECIPIENT_OPTED_OUT"
    });
    expect(evaluateFreeFormReply(conversation({ automationPaused: true }), new Date())).toMatchObject({
      code: "WHATSAPP_AUTOMATION_PAUSED"
    });
  });

  it("dispatches a compliant reply through the idempotent provider boundary", async () => {
    const provider = capability(conversation());
    const result = await dispatchFreeFormReply(provider, sendPrincipal, {
      conversationRef: "conversation_123",
      text: "Your order is ready.",
      idempotencyKey: "reply:order:123"
    });

    expect(result).toMatchObject({ ok: true, messageRef: "message_1", status: "accepted" });
    expect(provider.resolveConversation).toHaveBeenCalledTimes(2);
    expect(provider.dispatchReplyWithPolicy).toHaveBeenCalledWith(expect.objectContaining({
      notAfter: "2026-09-05T12:00:00.000Z",
      expectedPolicyRevision: "revision_1"
    }));
  });

  it("rechecks the service window immediately before dispatch and never sends after it closes", async () => {
    const provider = capability(conversation());
    const times = [
      new Date("2026-09-05T11:59:59.999Z"),
      new Date("2026-09-05T12:00:00.000Z")
    ];
    provider.now = () => times.shift() ?? times[0];

    const result = await dispatchFreeFormReply(provider, sendPrincipal, {
      conversationRef: "conversation_123",
      text: "This must not cross the boundary.",
      idempotencyKey: "reply:boundary:1"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED" }
    });
    expect(provider.dispatchReplyWithPolicy).not.toHaveBeenCalled();
  });

  it("does not validate or dispatch against a different canonical conversation after re-resolution", async () => {
    const provider = capability(conversation());
    provider.resolveConversation = vi.fn()
      .mockResolvedValueOnce(conversation())
      .mockResolvedValueOnce(conversation({ canonicalConversationRef: "tenant_1:conversation_other" }));

    const result = await dispatchFreeFormReply(provider, sendPrincipal, {
      conversationRef: "conversation_123",
      text: "Do not redirect this message.",
      idempotencyKey: "reply:target-change"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WHATSAPP_CONVERSATION_STATE_CHANGED", retryable: true }
    });
    expect(provider.validateOutboundContent).not.toHaveBeenCalled();
    expect(provider.dispatchReplyWithPolicy).not.toHaveBeenCalled();
  });

  it("requires a send scope and blocks disallowed content before provider dispatch", async () => {
    const provider = capability(conversation());
    const readOnlyPrincipal = { ...sendPrincipal, scopes: new Set(["whatsapp.policy.read", "whatsapp.connection.read"]) };
    const noScope = await dispatchFreeFormReply(provider, readOnlyPrincipal, {
      conversationRef: "conversation_123",
      text: "Hello",
      idempotencyKey: "reply:no-scope"
    });
    expect(noScope).toMatchObject({ ok: false, error: { code: "WHATSAPP_SEND_SCOPE_REQUIRED" } });

    provider.validateOutboundContent = vi.fn(async () => ({
      allowed: false as const,
      message: "This message conflicts with the configured business safety policy."
    }));
    const blocked = await dispatchApprovedTemplate(provider, sendPrincipal, {
      conversationRef: "conversation_123",
      templateName: "order_update",
      variables: [],
      idempotencyKey: "template:blocked:1"
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: "WHATSAPP_CONTENT_POLICY_BLOCKED" } });
    expect(provider.dispatchTemplateWithPolicy).not.toHaveBeenCalled();
  });
});
