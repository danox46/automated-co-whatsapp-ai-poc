import { createHmac } from "node:crypto";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createPilotInstallationRegistry } from "../src/meta/pilotInstallationStore.js";
import { opaqueConversationRef } from "../src/meta/conversationEvents.js";

const id = () => crypto.getRandomValues(new Uint32Array(2)).join("").padEnd(12, "1");
const request = (body: unknown, signed = true) => {
  const text = JSON.stringify(body);
  return new Request("https://pilot.test/webhooks/meta/whatsapp", { method: "POST", body: text,
    headers: signed ? { "x-hub-signature-256": `sha256=${createHmac("sha256", "test-app-secret").update(text).digest("hex")}` } : {} });
};

describe("durable account lifecycle diagnostics", () => {
  it("expires inactive diagnostics through the actual alarm and protects a replacement owner's records from stale deletion", async () => {
    const waba = env.PILOT_INSTALLATIONS.getByName(`waba:${id()}`);
    const old = new Date(Date.now() - 91 * 86400000).toISOString();
    await runInDurableObject(waba, async (instance, state) => {
      await instance.recordAccountUpdate({ event: "PARTNER_ADDED", occurredAt: old }, old);
      // workerd clamps past alarm deadlines to now. The actual alarm must
      // still purge expired rows without waiting for another webhook/read.
      expect(await state.storage.getAlarm()).not.toBeNull();
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.exec("SELECT event FROM account_updates").toArray()).toEqual([]);
    });
    const now = new Date().toISOString();
    await waba.putWabaRoute("new_owner");
    await waba.recordAccountUpdate({ event: "PARTNER_ADDED", occurredAt: now }, now);
    await runInDurableObject(waba, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(Date.parse(now) + 90 * 86400000);
    });
    await waba.clearAccountUpdates("stale_owner");
    expect(await waba.getAccountUpdates(now)).toHaveLength(1);
    await waba.clearAccountUpdates("new_owner");
    expect(await waba.getAccountUpdates(now)).toEqual([]);
  });
  it("deduplicates across fresh stubs, isolates WABAs, and prunes to50 records/90days", async () => {
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    const wabaId = id(); const now = new Date();
    const original = { wabaId, event: "PARTNER_ADDED", occurredAt: now.toISOString() };
    await registry.recordAccountUpdate(original, now);
    await registry.recordAccountUpdate(original, new Date(now.getTime() + 1000));
    const reopened = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    expect(await reopened.getAccountUpdates(wabaId, now)).toEqual([
      { event: original.event, occurredAt: original.occurredAt, receivedAt: now.toISOString() }
    ]);
    expect(await reopened.getAccountUpdates(id(), now)).toEqual([]);
    expect(await reopened.getInstallation(`absent_${wabaId}`)).toBeNull();
    for (let index = 1; index <= 55; index++) {
      await registry.recordAccountUpdate({ ...original, occurredAt: new Date(now.getTime() + index).toISOString() }, now);
    }
    const retained = await reopened.getAccountUpdates(wabaId, now);
    expect(retained).toHaveLength(50);
    expect(retained[0].occurredAt).toBe(new Date(now.getTime() + 55).toISOString());
    expect(await reopened.getAccountUpdates(wabaId, new Date(now.getTime() + 91 * 86400000))).toEqual([]);
  });

  it("captures an authenticated pre-binding event without creating access, then exposes only bounded diagnostics to admin", async () => {
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    const wabaId = id(); const portfolioId = id(); const tenantId = `lifecycle_${id()}`;
    const now = new Date(); const occurredAt = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
    const body = { object: "whatsapp_business_account", entry: [{ id: portfolioId,
      time: Date.parse(occurredAt) / 1000, changes: [{ field: "account_update", value: {
        event: "PARTNER_ADDED", waba_info: { waba_id: wabaId, owner_business_id: portfolioId, private: "not retained" }
      } }] }] };
    expect((await exports.default.fetch(request(body, false))).status).toBe(401);
    expect(await registry.getAccountUpdates(wabaId)).toEqual([]);
    expect((await exports.default.fetch(request(body))).status).toBe(200);
    expect(await registry.getWabaBindingOwner(wabaId)).toBeNull();
    expect(await registry.getAccountUpdates(portfolioId)).toEqual([]);
    await registry.refreshInstallation({ tenantId, wabaId, phoneNumberId: id(),
      encryptedAccessToken: { version: 1, iv: "synthetic", ciphertext: "synthetic" },
      connectedAt: now.toISOString(), webhookSubscribedAt: now.toISOString(), status: "connected" });
    const url = `https://pilot.test/admin/pilot/installations/${tenantId}`;
    expect((await exports.default.fetch(new Request(url))).status).toBe(401);
    const response = await exports.default.fetch(new Request(url, { headers: { Authorization: "Bearer test-pilot-admin-token" } }));
    expect(response.status).toBe(200);
    const value = await response.json() as { accountUpdates: unknown[] };
    expect(value.accountUpdates).toEqual([{ event: "PARTNER_ADDED", occurredAt, receivedAt: expect.any(String) }]);
    expect(JSON.stringify(value)).not.toContain(wabaId);
    expect(JSON.stringify(value)).not.toContain(portfolioId);
    expect(JSON.stringify(value)).not.toContain("not retained");
  });

  it("keeps message ingestion working when a partner update shares the signed envelope", async () => {
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    const wabaId = id(); const portfolioId = id(); const tenantId = `mixed_${id()}`;
    const phone = id(); const sender = id(); const messageRef = `synthetic-${id()}`;
    const now = new Date(); const time = Math.floor(now.getTime() / 1000);
    await registry.refreshInstallation({ tenantId, wabaId, phoneNumberId: phone,
      encryptedAccessToken: { version: 1, iv: "synthetic", ciphertext: "synthetic" },
      connectedAt: now.toISOString(), webhookSubscribedAt: now.toISOString(), status: "connected" });
    const payload = { object: "whatsapp_business_account", entry: [
      { id: portfolioId, time, changes: [{ field: "account_update", value: {
        event: "PARTNER_ADDED", waba_info: { waba_id: wabaId } } }] },
      { id: wabaId, time, changes: [{ field: "messages", value: { metadata: { phone_number_id: phone },
        messages: [{ id: messageRef, from: sender, type: "text", timestamp: String(time), text: { body: "Synthetic mixed callback" } }] } }] }
    ] };
    expect((await exports.default.fetch(request(payload))).status).toBe(200);
    const ref = await opaqueConversationRef(tenantId, phone, sender, "test-conversation-reference-secret");
    const history = await env.CONVERSATIONS.getByName(tenantId).getConversationHistory({ conversationRef: ref });
    expect(history?.messages.map(message => message.messageRef)).toEqual([messageRef]);
    expect(await registry.getAccountUpdates(wabaId)).toHaveLength(1);
  });
});
