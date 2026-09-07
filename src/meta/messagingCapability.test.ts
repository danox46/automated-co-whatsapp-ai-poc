import { describe, expect, it, vi } from "vitest";
import type { WhatsAppMcpPrincipal } from "../mcp/auth.js";
import type { DurableConversationNamespace } from "../mcp/durableConversationStore.js";
import { createMetaMessagingCapability } from "./messagingCapability.js";
import type { createMetaGraphClient } from "./graphClient.js";
import type { createPilotInstallationRegistry } from "./pilotInstallationStore.js";

describe("Meta sandbox dispatch restriction", () => {
  it("blocks an unapproved recipient before decrypting or calling Meta", async () => {
    const sendText = vi.fn();
    const sendTemplate = vi.fn();
    const conversationStub = {
      initializeTenant: vi.fn(),
      reserveOutboundDispatch: vi.fn(async () => ({
        status: "ready" as const,
        providerAccountRef: "5550001001",
        providerParticipantRef: "15550000002"
      }))
    };
    const conversations = {
      getByName: () => conversationStub
    } as unknown as DurableConversationNamespace;
    const registry = {
      getInstallation: vi.fn()
    } as unknown as ReturnType<typeof createPilotInstallationRegistry>;
    const graph = {
      sendText,
      sendTemplate
    } as unknown as ReturnType<typeof createMetaGraphClient>;
    const capability = createMetaMessagingCapability({
      conversations,
      registry,
      graph,
      encryptionKey: "unused-because-the-allowlist-blocks-first",
      recipientAllowed: (_tenantId, recipient) => recipient === "15550000001"
    });
    const principal: WhatsAppMcpPrincipal = {
      subject: "owner",
      tenantId: "automated-co-sandbox",
      audience: "https://pilot.example.workers.dev",
      scopes: new Set(["whatsapp.messages.send"])
    };
    const conversation = {
      canonicalConversationRef: "conv_sandbox_recipient_reference",
      providerParticipantRef: "15550000002",
      policyRevision: "v1",
      lastVerifiedUserInboundAt: "2026-09-07T15:00:00.000Z",
      recipientOptedOut: false,
      automationPaused: false,
      consentedTemplateCategories: new Set(["UTILITY"]),
      consentedTemplatePurposes: new Set(["sandbox_notification"]),
      approvedTemplates: [{
        name: "automated_co_sandbox_notification",
        category: "UTILITY",
        purpose: "sandbox_notification",
        languageCode: "en_US",
        enabled: true
      }]
    };

    await expect(capability.dispatchReplyWithPolicy({
      principal,
      conversation,
      text: "sandbox test",
      idempotencyKey: "sandbox-block-1",
      notAfter: "2026-09-08T15:00:00.000Z",
      expectedPolicyRevision: "v1"
    })).resolves.toMatchObject({
      allowed: false,
      code: "WHATSAPP_SANDBOX_RECIPIENT_NOT_ALLOWED"
    });
    await expect(capability.dispatchTemplateWithPolicy({
      principal,
      conversation,
      templateName: "automated_co_sandbox_notification",
      variables: ["sandbox test"],
      idempotencyKey: "sandbox-block-2",
      expectedPolicyRevision: "v1"
    })).resolves.toMatchObject({
      allowed: false,
      code: "WHATSAPP_SANDBOX_RECIPIENT_NOT_ALLOWED"
    });
    expect(registry.getInstallation).not.toHaveBeenCalled();
    expect(conversationStub.reserveOutboundDispatch).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});
