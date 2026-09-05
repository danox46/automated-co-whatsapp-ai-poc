import { describe, expect, it } from "vitest";
import type { WhatsAppMcpPrincipal } from "./auth.js";
import { InMemoryWhatsAppConversationStore } from "./conversationHistory.js";

const now = new Date("2026-09-05T12:00:00.000Z");
const tenantOne: WhatsAppMcpPrincipal = {
  subject: "owner-1",
  tenantId: "tenant-1",
  audience: "https://example.test",
  scopes: new Set(["whatsapp.conversations.read"])
};
const tenantTwo: WhatsAppMcpPrincipal = {
  ...tenantOne,
  subject: "owner-2",
  tenantId: "tenant-2"
};

function inbound(tenantId: string, messageRef: string, conversationRef: string, occurredAt: string) {
  return {
    tenantId,
    providerAccountRef: "provider-account",
    providerParticipantRef: "provider-participant",
    displayName: "Customer",
    messageRef,
    conversationRef,
    direction: "inbound" as const,
    kind: "text" as const,
    text: `body:${messageRef}`,
    occurredAt,
    status: "received" as const
  };
}

describe("conversation history store", () => {
  it("deduplicates messages and returns policy-aware structured history", async () => {
    const store = new InMemoryWhatsAppConversationStore(() => now);
    const message = inbound("tenant-1", "message-1", "conv-1", "2026-09-05T11:00:00.000Z");
    await store.ingestMessage(message);
    await store.ingestMessage(message);
    await store.updateMessageStatus({
      tenantId: "tenant-1",
      messageRef: "message-1",
      status: "read",
      occurredAt: "2026-09-05T11:01:00.000Z"
    });
    await store.updatePolicyState({
      tenantId: "tenant-1",
      conversationRef: "conv-1",
      automationPaused: true,
      policyRevision: "v2"
    });

    const result = await store.getConversationHistory(tenantOne, {
      conversationRef: "conv-1"
    });
    expect(result).toMatchObject({
      conversation: {
        conversationRef: "conv-1",
        messageCount: 1,
        automationPaused: true,
        policyRevision: "v2",
        customerServiceWindow: {
          status: "open",
          closesAt: "2026-09-06T11:00:00.000Z"
        }
      },
      messages: [{ messageRef: "message-1", text: "body:message-1", status: "read" }]
    });
  });

  it("isolates tenants without accepting a caller-supplied tenant selector", async () => {
    const store = new InMemoryWhatsAppConversationStore(() => now);
    await store.ingestMessage(inbound("tenant-1", "message-1", "conv-1", now.toISOString()));
    await store.ingestMessage(inbound("tenant-2", "message-2", "conv-2", now.toISOString()));

    expect((await store.listConversations(tenantOne, {})).conversations.map((item) => item.conversationRef))
      .toEqual(["conv-1"]);
    expect((await store.listConversations(tenantTwo, {})).conversations.map((item) => item.conversationRef))
      .toEqual(["conv-2"]);
    expect(await store.getConversationHistory(tenantOne, { conversationRef: "conv-2" })).toBeNull();
  });

  it("paginates conversations and messages with bounded opaque cursors", async () => {
    const store = new InMemoryWhatsAppConversationStore(() => now);
    await store.ingestMessage(inbound("tenant-1", "message-1", "conv-1", "2026-09-05T10:00:00.000Z"));
    await store.ingestMessage(inbound("tenant-1", "message-2", "conv-2", "2026-09-05T11:00:00.000Z"));
    await store.ingestMessage(inbound("tenant-1", "message-3", "conv-2", "2026-09-05T11:30:00.000Z"));

    const firstConversations = await store.listConversations(tenantOne, { limit: 1 });
    expect(firstConversations.conversations[0].conversationRef).toBe("conv-2");
    expect(firstConversations.nextCursor).toBeDefined();
    const secondConversations = await store.listConversations(tenantOne, {
      limit: 1,
      cursor: firstConversations.nextCursor
    });
    expect(secondConversations.conversations[0].conversationRef).toBe("conv-1");

    const firstMessages = await store.getConversationHistory(tenantOne, {
      conversationRef: "conv-2",
      limit: 1
    });
    expect(firstMessages?.messages[0].messageRef).toBe("message-3");
    const secondMessages = await store.getConversationHistory(tenantOne, {
      conversationRef: "conv-2",
      limit: 1,
      cursor: firstMessages?.nextCursor
    });
    expect(secondMessages?.messages[0].messageRef).toBe("message-2");
  });

  it("rejects malformed cursors instead of widening the query", async () => {
    const store = new InMemoryWhatsAppConversationStore(() => now);
    await expect(store.listConversations(tenantOne, { cursor: "not-a-valid-cursor" }))
      .rejects.toThrow("Invalid conversation cursor");
  });
});
