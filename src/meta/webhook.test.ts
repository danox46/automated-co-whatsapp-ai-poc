import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  handleMetaWhatsAppWebhook,
  metaWebhookWabaIds,
  META_WHATSAPP_WEBHOOK_PATH,
  type MetaWebhookEnv
} from "./webhook.js";
import { InMemoryWhatsAppConversationStore } from "../mcp/conversationHistory.js";

const origin = "https://automated-co-whatsapp-sandbox.example.workers.dev";
const env: MetaWebhookEnv = {
  META_WEBHOOK_VERIFY_TOKEN: "fixed-test-verify-token",
  META_APP_SECRET: "fixed-test-app-secret"
};

function sign(body: string) {
  return `sha256=${createHmac("sha256", env.META_APP_SECRET).update(body).digest("hex")}`;
}

describe("Meta WhatsApp webhook", () => {
  it("returns the verification challenge only for the configured token", async () => {
    const url = new URL(META_WHATSAPP_WEBHOOK_PATH, origin);
    url.searchParams.set("hub.mode", "subscribe");
    url.searchParams.set("hub.verify_token", env.META_WEBHOOK_VERIFY_TOKEN);
    url.searchParams.set("hub.challenge", "verified-challenge");

    const response = await handleMetaWhatsAppWebhook(new Request(url), env);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("verified-challenge");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects an incorrect verification token", async () => {
    const url = new URL(META_WHATSAPP_WEBHOOK_PATH, origin);
    url.searchParams.set("hub.mode", "subscribe");
    url.searchParams.set("hub.verify_token", "wrong-token");
    url.searchParams.set("hub.challenge", "must-not-leak");

    const response = await handleMetaWhatsAppWebhook(new Request(url), env);
    expect(response?.status).toBe(403);
    expect(await response?.text()).not.toContain("must-not-leak");
  });

  it("acknowledges a signed WhatsApp Business Account event without echoing it", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { messages: [{ text: { body: "private" } }] } }] }]
    });
    const response = await handleMetaWhatsAppWebhook(new Request(
      new URL(META_WHATSAPP_WEBHOOK_PATH, origin),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body)
        },
        body
      }
    ), env);

    expect(response?.status).toBe(200);
    const responseText = await response?.text();
    expect(responseText).toBe('{"received":true}');
    expect(responseText).not.toContain("private");
  });

  it("persists only normalized bounded conversation records after signature verification", async () => {
    const store = new InMemoryWhatsAppConversationStore(
      () => new Date("2026-09-05T12:00:00.000Z")
    );
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "provider-account-123" },
            contacts: [{ wa_id: "recipient-456", profile: { name: "Customer" } }],
            messages: [{
              from: "recipient-456",
              id: "wamid.inbound-1",
              timestamp: "1788606000",
              type: "text",
              text: { body: "Where is my order?" },
              raw_secret_field: "must-not-be-stored"
            }]
          }
        }]
      }]
    });
    const response = await handleMetaWhatsAppWebhook(new Request(
      new URL(META_WHATSAPP_WEBHOOK_PATH, origin),
      {
        method: "POST",
        headers: { "x-hub-signature-256": sign(body) },
        body
      }
    ), env, {
      tenantId: "tenant-1",
      conversationRefSecret: "fixed-conversation-reference-secret",
      writer: store
    });

    expect(response?.status).toBe(200);
    const list = await store.listConversations({
      subject: "owner",
      tenantId: "tenant-1",
      audience: origin,
      scopes: new Set(["whatsapp.conversations.read"])
    }, {});
    expect(list.conversations).toHaveLength(1);
    expect(list.conversations[0].conversationRef).toMatch(/^conv_[A-Za-z0-9_-]{32}$/);
    const history = await store.getConversationHistory({
      subject: "owner",
      tenantId: "tenant-1",
      audience: origin,
      scopes: new Set(["whatsapp.conversations.read"])
    }, { conversationRef: list.conversations[0].conversationRef });
    expect(history?.messages).toEqual([
      expect.objectContaining({
        messageRef: "wamid.inbound-1",
        text: "Where is my order?",
        direction: "inbound"
      })
    ]);
    expect(JSON.stringify(history)).not.toContain("provider-account-123");
    expect(JSON.stringify(history)).not.toContain("recipient-456");
    expect(JSON.stringify(history)).not.toContain("must-not-be-stored");
  });

  it("resolves the tenant from the signed WABA envelope before persistence", async () => {
    const store = new InMemoryWhatsAppConversationStore();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "100200300",
        changes: [{ field: "messages", value: {
          metadata: { phone_number_id: "400500600" },
          contacts: [{ wa_id: "573001112233" }],
          messages: [{
            from: "573001112233",
            id: "wamid.tenant-route",
            timestamp: "1788606000",
            type: "text",
            text: { body: "Tenant routed" }
          }]
        } }]
      }]
    });
    expect(metaWebhookWabaIds(JSON.parse(body))).toEqual(["100200300"]);
    const response = await handleMetaWhatsAppWebhook(new Request(
      new URL(META_WHATSAPP_WEBHOOK_PATH, origin),
      { method: "POST", headers: { "x-hub-signature-256": sign(body) }, body }
    ), env, async (payload) => metaWebhookWabaIds(payload)[0] === "100200300" ? {
      tenantId: "tenant-routed",
      conversationRefSecret: "fixed-conversation-reference-secret",
      writer: store
    } : null);

    expect(response?.status).toBe(200);
    const result = await store.listConversations({
      subject: "pilot",
      tenantId: "tenant-routed",
      audience: origin,
      scopes: new Set(["whatsapp.conversations.read"])
    }, {});
    expect(result.conversations).toHaveLength(1);
  });

  it("returns a retryable error instead of acknowledging a configured persistence failure", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "provider-account" },
          messages: [{
            from: "recipient",
            id: "wamid.retry-me",
            timestamp: "1788606000",
            type: "text",
            text: { body: "private retry content" }
          }]
        }
      }] }]
    });
    const fail = async () => { throw new Error("storage unavailable"); };
    const response = await handleMetaWhatsAppWebhook(new Request(
      new URL(META_WHATSAPP_WEBHOOK_PATH, origin),
      {
        method: "POST",
        headers: { "x-hub-signature-256": sign(body) },
        body
      }
    ), env, {
      tenantId: "tenant-1",
      conversationRefSecret: "fixed-conversation-reference-secret",
      writer: {
        ingestMessage: fail,
        updateMessageStatus: fail,
        updatePolicyState: fail,
        markConversationRead: fail,
        pruneMessages: fail
      }
    });

    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe('{"received":false,"retryable":true}');
  });

  it("rejects unsigned, incorrectly signed, malformed, and non-WhatsApp events", async () => {
    const validBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const cases = [
      new Request(new URL(META_WHATSAPP_WEBHOOK_PATH, origin), { method: "POST", body: validBody }),
      new Request(new URL(META_WHATSAPP_WEBHOOK_PATH, origin), {
        method: "POST",
        headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
        body: validBody
      }),
      new Request(new URL(META_WHATSAPP_WEBHOOK_PATH, origin), {
        method: "POST",
        headers: { "x-hub-signature-256": sign("not-json") },
        body: "not-json"
      }),
      (() => {
        const body = JSON.stringify({ object: "page", entry: [] });
        return new Request(new URL(META_WHATSAPP_WEBHOOK_PATH, origin), {
          method: "POST",
          headers: { "x-hub-signature-256": sign(body) },
          body
        });
      })()
    ];

    const statuses = [];
    for (const request of cases) {
      statuses.push((await handleMetaWhatsAppWebhook(request, env))?.status);
    }
    expect(statuses).toEqual([401, 401, 400, 400]);
  });

  it("rejects oversized payloads before processing", async () => {
    const response = await handleMetaWhatsAppWebhook(new Request(
      new URL(META_WHATSAPP_WEBHOOK_PATH, origin),
      {
        method: "POST",
        headers: { "content-length": String(256 * 1024 + 1) },
        body: "{}"
      }
    ), env);
    expect(response?.status).toBe(413);
  });

  it("ignores unrelated routes and rejects other methods", async () => {
    expect(await handleMetaWhatsAppWebhook(new Request(`${origin}/unrelated`), env)).toBeNull();
    const response = await handleMetaWhatsAppWebhook(new Request(
      new URL(META_WHATSAPP_WEBHOOK_PATH, origin),
      { method: "PUT" }
    ), env);
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe("GET, POST");
  });
});
