import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  handleMetaWhatsAppWebhook,
  META_WHATSAPP_WEBHOOK_PATH,
  type MetaWebhookEnv
} from "./webhook.js";

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
