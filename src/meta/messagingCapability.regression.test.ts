import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableObjectState } from "cloudflare:workers";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: unknown) {}
  }
}));
import { WhatsAppConversationDurableObject, type DurableConversationNamespace } from "../mcp/durableConversationStore.js";
import { dispatchApprovedTemplate, dispatchFreeFormReply } from "../mcp/outboundPolicy.js";
import * as cryptoHelpers from "./pilotCrypto.js";
import { createDurableWhatsAppPolicyDirectory, createMetaMessagingCapability } from "./messagingCapability.js";
import type { createPilotInstallationRegistry, PilotInstallationRecord } from "./pilotInstallationStore.js";
import type { createMetaGraphClient } from "./graphClient.js";
import { createMetaGraphClient as graphClient } from "./graphClient.js";

const databases: DatabaseSync[] = [];
const sqliteModule = await import("node:sqlite").catch(() => null);
const describeWithSqlite = sqliteModule ? describe : describe.skip;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});
const encryptionKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

async function fixture() {
  if (!sqliteModule) throw new Error("node:sqlite unavailable");
  const db = new sqliteModule.DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  databases.push(db);
  const ctx = {
    storage: { sql: { exec(query: string, ...bindings: (string | number | null)[]) {
      let rows: unknown[] = [];
      if (!bindings.length && query.includes(";")) db.exec(query);
      else rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => {
        if (rows.length !== 1) throw new Error("Expected one row");
        return rows[0];
      } };
    } } },
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback()
  } as unknown as DurableObjectState;
  const store = new WhatsAppConversationDurableObject(ctx, {});
  await store.initializeTenant("tenant-test");
  await store.ingestMessage({
    conversationRef: "conv-test", providerAccountRef: "123456789",
    providerParticipantRef: "15550000001", messageRef: "wamid.inbound",
    direction: "inbound", kind: "text", text: "Hello",
    occurredAt: "2026-10-03T12:00:00.000Z", status: "received"
  });
  const template = { name: "status_update", category: "UTILITY", purpose: "status", languageCode: "en_US", enabled: true };
  await store.upsertApprovedTemplate(template);
  await store.setConversationTemplateConsent({
    conversationRef: "conv-test", categories: ["UTILITY"], purposes: ["status"],
    policyRevision: "v1", updatedAt: "2026-10-03T12:00:00.000Z"
  });
  const installation: PilotInstallationRecord = {
    tenantId: "tenant-test", wabaId: "987654321", phoneNumberId: "123456789",
    encryptedAccessToken: await cryptoHelpers.encryptPilotSecret("fixture-token", encryptionKey),
    connectedAt: "2026-10-03T12:00:00.000Z", webhookSubscribedAt: "2026-10-03T12:00:00.000Z", status: "connected"
  };
  const getInstallation = vi.fn(async () => installation);
  const sendText = vi.fn(async () => ({ messageRef: "wamid.reply", status: "accepted" as const }));
  const sendTemplate = vi.fn(async () => ({ messageRef: "wamid.template", status: "accepted" as const }));
  const recipientAllowed = vi.fn(async () => true);
  let clock = new Date("2026-10-04T11:59:59.000Z");
  const conversations = { getByName: () => store } as unknown as DurableConversationNamespace;
  const capability = createMetaMessagingCapability({
    conversations, encryptionKey, policyDirectory: createDurableWhatsAppPolicyDirectory(conversations),
    registry: { getInstallation } as unknown as ReturnType<typeof createPilotInstallationRegistry>,
    graph: { sendText, sendTemplate } as unknown as ReturnType<typeof createMetaGraphClient>,
    recipientAllowed, now: () => clock
  });
  const principal = {
    subject: "owner", tenantId: "tenant-test", audience: "https://pilot.test",
    scopes: new Set(["whatsapp.messages.send"])
  };
  const send = (kind: "reply" | "template", key = "test-send-key") => kind === "reply"
    ? dispatchFreeFormReply(capability, principal, { conversationRef: "conv-test", text: "Hi", idempotencyKey: key })
    : dispatchApprovedTemplate(capability, principal, { conversationRef: "conv-test", templateName: template.name, variables: ["Hi"], idempotencyKey: key });
  return { db, store, template, installation, getInstallation, sendText, sendTemplate, recipientAllowed,
    send, setClock: (value: string) => { clock = new Date(value); } };
}

describeWithSqlite("authoritative outbound dispatch regressions", () => {
  it("allows only one provider invocation for concurrent requests with the same key", async () => {
    const f = await fixture();
    const results = await Promise.all([f.send("reply"), f.send("reply")]);
    expect(results.some(result => result.ok)).toBe(true);
    expect(f.sendText).toHaveBeenCalledTimes(1);
  });
  it("does not resend after an actual Graph response-body timeout", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const cancel = vi.fn();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const graph = graphClient({ appId: "fixture-app", appSecret: "fixture-secret", graphVersion: "v25.0", timeoutMs: 100, fetch: request });
    f.sendText.mockImplementation(() => graph.sendText("fixture-token", "123456789", "15550000001", "Hi"));
    const result = f.send("reply");
    const assertion = expect(result).rejects.toMatchObject({ code: "META_REQUEST_TIMEOUT" });
    // Crypto completes on the native event loop, independently of fake time.
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1), { interval: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await f.send("reply")).toMatchObject({ ok: false, error: { code: "WHATSAPP_SEND_IN_PROGRESS" } });
    expect(request).toHaveBeenCalledTimes(1);
  });
  for (const phase of ["installation", "decryption"] as const) {
    it(`blocks a reply when its window expires during ${phase}`, async () => {
      const f = await fixture();
      const change = async () => f.setClock("2026-10-04T12:00:01.000Z");
      if (phase === "installation") f.getInstallation.mockImplementationOnce(async () => { await change(); return f.installation; });
      else {
        const decrypt = cryptoHelpers.decryptPilotSecret;
        vi.spyOn(cryptoHelpers, "decryptPilotSecret").mockImplementationOnce(async (...args) => { const token = await decrypt(...args); await change(); return token; });
      }
      expect(await f.send("reply")).toMatchObject({ ok: false, error: { code: "WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED" } });
      expect(f.sendText).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT COUNT(*) AS count FROM outbound_dispatches").get()).toMatchObject({ count: 0 });
    });
    for (const kind of ["reply", "template"] as const) {
      for (const flag of ["recipientOptedOut", "automationPaused"] as const) {
        it(`blocks ${kind} when ${flag} changes during ${phase}`, async () => {
          const f = await fixture();
          const change = () => f.store.updatePolicyState({ conversationRef: "conv-test", [flag]: true, policyRevision: "v2" });
          if (phase === "installation") f.getInstallation.mockImplementationOnce(async () => { await change(); return f.installation; });
          else {
            const decrypt = cryptoHelpers.decryptPilotSecret;
            vi.spyOn(cryptoHelpers, "decryptPilotSecret").mockImplementationOnce(async (...args) => { const token = await decrypt(...args); await change(); return token; });
          }
          expect(await f.send(kind)).toMatchObject({ ok: false });
          expect(f.sendText).not.toHaveBeenCalled();
          expect(f.sendTemplate).not.toHaveBeenCalled();
        });
      }
    }
  }
  for (const patch of [{ enabled: false }, { category: "MARKETING" }, { purpose: "promotion" }, { languageCode: "es_CO" }]) {
    it(`blocks stale template authorization after ${JSON.stringify(patch)}`, async () => {
      const f = await fixture();
      f.recipientAllowed.mockImplementationOnce(async () => { await f.store.upsertApprovedTemplate({ ...f.template, ...patch }); return true; });
      expect(await f.send("template")).toMatchObject({ ok: false });
      expect(f.sendTemplate).not.toHaveBeenCalled();
    });
  }
  it("checks current category and purpose consent at reservation even for a stale snapshot with the same revision", async () => {
    const f = await fixture();
    f.getInstallation.mockImplementationOnce(async () => {
      await f.store.setConversationTemplateConsent({ conversationRef: "conv-test", categories: ["UTILITY"], purposes: [], policyRevision: "v1", updatedAt: "2026-10-04T11:59:59.000Z" });
      return f.installation;
    });
    expect(await f.send("template")).toMatchObject({ ok: false, error: { code: "WHATSAPP_TEMPLATE_CONSENT_REQUIRED" } });
    expect(f.sendTemplate).not.toHaveBeenCalled();
  });
  for (const kind of ["reply", "template"] as const) {
    for (const failure of ["disconnected", "wrong-phone", "decryption"] as const) {
      it(`can retry the same ${kind} key after definite pre-provider ${failure} failure`, async () => {
        const f = await fixture();
        if (failure === "disconnected") f.getInstallation.mockResolvedValueOnce({ ...f.installation, status: "disconnected" });
        if (failure === "wrong-phone") f.getInstallation.mockResolvedValueOnce({ ...f.installation, phoneNumberId: "111111111" });
        if (failure === "decryption") vi.spyOn(cryptoHelpers, "decryptPilotSecret").mockRejectedValueOnce(new Error("fixture failure"));
        if (failure === "decryption") await expect(f.send(kind)).rejects.toThrow("fixture failure");
        else expect(await f.send(kind)).toMatchObject({ ok: false });
        expect(f.db.prepare("SELECT COUNT(*) AS count FROM outbound_dispatches").get()).toMatchObject({ count: 0 });
        expect(await f.send(kind)).toMatchObject({ ok: true });
        expect(kind === "reply" ? f.sendText : f.sendTemplate).toHaveBeenCalledTimes(1);
      });
    }
    it(`returns the original completed ${kind} receipt without repeating preparation or sending`, async () => {
      const f = await fixture();
      const first = await f.send(kind);
      f.getInstallation.mockRejectedValue(new Error("unavailable"));
      expect(await f.send(kind)).toEqual(first);
      expect(f.getInstallation).toHaveBeenCalledTimes(1);
      expect(kind === "reply" ? f.sendText : f.sendTemplate).toHaveBeenCalledTimes(1);
    });
    for (const failure of ["provider", "completion"] as const) {
      it(`does not resend ${kind} after an ambiguous ${failure} failure`, async () => {
        const f = await fixture();
        if (failure === "provider") (kind === "reply" ? f.sendText : f.sendTemplate).mockRejectedValueOnce(new Error("ambiguous"));
        else vi.spyOn(f.store, "completeOutboundDispatch").mockRejectedValueOnce(new Error("ambiguous"));
        await expect(f.send(kind)).rejects.toThrow("ambiguous");
        expect(await f.send(kind)).toMatchObject({ ok: false, error: { code: "WHATSAPP_SEND_IN_PROGRESS" } });
        expect(kind === "reply" ? f.sendText : f.sendTemplate).toHaveBeenCalledTimes(1);
      });
    }
  }
  it("rechecks expiry after the reservation RPC and cancels only the unsent key", async () => {
    const f = await fixture();
    const reserve = f.store.reserveOutboundDispatch.bind(f.store);
    vi.spyOn(f.store, "reserveOutboundDispatch").mockImplementationOnce(async (input) => {
      const result = await reserve(input);
      f.setClock("2026-10-04T12:00:00.000Z");
      return result;
    });
    expect(await f.send("reply")).toMatchObject({ ok: false, error: { code: "WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED" } });
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM outbound_dispatches").get()).toMatchObject({ count: 0 });
    await f.store.ingestMessage({ conversationRef: "conv-test", providerAccountRef: "123456789", providerParticipantRef: "15550000001", messageRef: "wamid.new-inbound", direction: "inbound", kind: "text", occurredAt: "2026-10-04T12:00:00.000Z", status: "received" });
    expect(await f.send("reply")).toMatchObject({ ok: true });
  });
});
