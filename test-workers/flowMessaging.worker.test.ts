import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createSandboxFlowMessaging } from "../src/meta/sandboxFlowMessaging.js";
import { encryptPilotSecret } from "../src/meta/pilotCrypto.js";
import { opaqueConversationRef } from "../src/meta/conversationEvents.js";
import { handleMetaWhatsAppWebhook } from "../src/meta/webhook.js";
import type { DurableConversationNamespace } from "../src/mcp/durableConversationStore.js";
import type { createPilotInstallationRegistry } from "../src/meta/pilotInstallationStore.js";
import type { createMetaGraphClient } from "../src/meta/graphClient.js";
import { MetaGraphError } from "../src/meta/graphClient.js";

async function fixture() {
  const tenantId = `flow_send_${crypto.randomUUID().replace(/-/gu, "").slice(0, 12)}`;
  const stub = env.CONVERSATIONS.getByName(tenantId);
  await stub.initializeTenant(tenantId);
  const conversationRef = await opaqueConversationRef(tenantId, "15550000002", "15550000001", "synthetic-reference-secret");
  await stub.ingestMessage({ conversationRef, providerAccountRef: "15550000002", providerParticipantRef: "15550000001", messageRef: "fixture-inbound", direction: "inbound", kind: "text", text: "Synthetic test", occurredAt: "2026-10-25T01:00:00.000Z", status: "received" });
  const encryptionKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
  const sandbox = { tenantId, wabaId: "15550000000", phoneNumberId: "15550000002", accessToken: "unused-synthetic-sandbox-token", allowedRecipients: ["15550000001"] };
  const installation = { ...sandbox, status: "connected", encryptedAccessToken: await encryptPilotSecret("synthetic-provider-token", encryptionKey) };
  const getInstallation = vi.fn(async () => installation);
  const listFlows = vi.fn(async () => [{ id: "111111", name: "Sol Sandbox - Agendar visita", status: "DRAFT" }, { id: "222222", name: "Sol Sandbox - Perfil mayorista", status: "DRAFT" }]);
  const sendDraftFlow = vi.fn(async (_token: string, _sender: string, _recipient: string, _flow: { token: string }) => ({ messageRef: "fixture-flow-launch", status: "accepted" as const }));
  let clock = new Date("2026-10-25T01:01:00.000Z");
  const config = { sandbox, flowIds: { visit: "111111", wholesale: "222222" }, conversations: env.CONVERSATIONS as DurableConversationNamespace,
    registry: { getInstallation } as unknown as ReturnType<typeof createPilotInstallationRegistry>,
    graph: { listFlows, sendDraftFlow } as unknown as ReturnType<typeof createMetaGraphClient>, encryptionKey, correlationSecret: "synthetic-reference-secret", now: () => clock };
  const service = createSandboxFlowMessaging(config);
  const principal = { subject: "synthetic-owner", tenantId, audience: "https://pilot.test", scopes: new Set(["whatsapp.messages.send"]) };
  const args = { conversationRef, flowType: "visit" as const, idempotencyKey: "original-draft-intent" };
  return { stub, service, config, principal, args, sendDraftFlow, listFlows, getInstallation, installation, sandbox, setClock: (value: string) => { clock = new Date(value); } };
}

describe("policy-enforced draft Flow dispatch", () => {
  it("allows one provider invocation for parallel original-key calls and returns its durable receipt on replay", async () => {
    const f = await fixture();
    const results = await Promise.all([f.service.send(f.principal, f.args), f.service.send(f.principal, f.args)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(f.sendDraftFlow).toHaveBeenCalledTimes(1);
    const original = results.find(r => r.ok);
    expect(await f.service.send(f.principal, f.args)).toEqual(original);
    expect(f.sendDraftFlow).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(original)).not.toContain("flow_token");
    expect(await f.service.send(f.principal, { ...f.args, flowType: "wholesale" })).toMatchObject({ ok: false, error: { code: "WHATSAPP_CONVERSATION_STATE_CHANGED" } });
    expect(f.sendDraftFlow).toHaveBeenCalledTimes(1);
  });
  it("keeps an uncertain original send reserved and never retries it into a duplicate", async () => {
    const f = await fixture();
    f.sendDraftFlow.mockRejectedValue(new Error("synthetic response lost"));
    expect(await f.service.send(f.principal, f.args)).toMatchObject({ ok: false, error: { code: "WHATSAPP_FLOW_OUTCOME_UNKNOWN" } });
    expect(await f.service.send(f.principal, f.args)).toMatchObject({ ok: false, error: { code: "WHATSAPP_SEND_IN_PROGRESS" } });
    expect(f.sendDraftFlow).toHaveBeenCalledTimes(1);
  });
  it("distinguishes a concrete provider rejection from a timeout without resending either", async () => {
    const f = await fixture();
    f.sendDraftFlow.mockRejectedValue(new MetaGraphError("META_MESSAGE_DISPATCH_FAILED_139000", 400, false));
    expect(await f.service.send(f.principal, f.args)).toMatchObject({ ok: false, error: { code: "WHATSAPP_FLOW_PROVIDER_REJECTED", message: expect.stringContaining("139000") } });
    expect(await f.service.send(f.principal, f.args)).toMatchObject({ ok: false, error: { code: "WHATSAPP_SEND_IN_PROGRESS" } });
    expect(f.sendDraftFlow).toHaveBeenCalledTimes(1);
  });
  for (const flag of ["recipientOptedOut", "automationPaused"] as const) {
    it(`rechecks ${flag} changed during the draft lookup before provider initiation`, async () => {
      const f = await fixture();
      f.listFlows.mockImplementation(async () => {
        await f.stub.updatePolicyState({ conversationRef: f.args.conversationRef, [flag]: true, policyRevision: "v2" });
        return [{ id: "111111", name: "Sol Sandbox - Agendar visita", status: "DRAFT" }];
      });
      expect(await f.service.send(f.principal, f.args)).toMatchObject({ ok: false });
      expect(f.sendDraftFlow).not.toHaveBeenCalled();
    });
  }
  it("blocks an expired window after slow preparation", async () => {
    const f = await fixture();
    f.getInstallation.mockImplementation(async () => { f.setClock("2026-10-26T01:00:00.000Z"); return f.installation; });
    expect(await f.service.send(f.principal, f.args)).toMatchObject({ ok: false });
    expect(f.sendDraftFlow).not.toHaveBeenCalled();
  });
  it("requires write scope, sandbox tenant, allowlisted recipient and a matching owned draft", async () => {
    const f = await fixture();
    expect(await f.service.send({ ...f.principal, scopes: new Set() }, f.args)).toMatchObject({ ok: false, error: { code: "WHATSAPP_SEND_SCOPE_REQUIRED" } });
    expect(await f.service.send({ ...f.principal, tenantId: "other-tenant" }, f.args)).toMatchObject({ ok: false, error: { code: "WHATSAPP_FLOW_NOT_AVAILABLE" } });
    f.sandbox.allowedRecipients = [];
    expect(await f.service.send(f.principal, f.args)).toMatchObject({ ok: false, error: { code: "WHATSAPP_SANDBOX_RECIPIENT_NOT_ALLOWED" } });
    f.sandbox.allowedRecipients = ["15550000001"];
    f.listFlows.mockResolvedValue([{ id: "111111", name: "Sol Sandbox - Agendar visita", status: "PUBLISHED" }]);
    expect(await f.service.send(f.principal, f.args)).toMatchObject({ ok: false, error: { code: "WHATSAPP_FLOW_NOT_AVAILABLE" } });
    expect(f.sendDraftFlow).not.toHaveBeenCalled();
  });
  it("runs launch → signed completion → durable structured answers and rejects an unsigned duplicate", async () => {
    const f = await fixture();
    expect(await f.service.send(f.principal, f.args)).toMatchObject({ ok: true });
    const token = f.sendDraftFlow.mock.calls[0][3].token;
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "15550000002" }, messages: [{ from: "15550000001", id: "fixture-form-complete", timestamp: "1792890180", type: "interactive", context: { id: "fixture-flow-launch" },
        interactive: { type: "nfm_reply", nfm_reply: { body: "Sent", response_json: JSON.stringify({ flow_token: token, source: "visit_schedule_flow", customer_name: "Synthetic Tester", phone: "+15550000001", visit_date: "2026-11-02", visit_time: "10_00_am" }) } } }]
    } }] }] });
    const persistence = { tenantId: f.principal.tenantId, conversationRefSecret: "synthetic-reference-secret", writer: {
      ingestMessage: async ({ tenantId: _tenant, ...message }: import("../src/mcp/conversationHistory.js").InternalConversationMessage) => f.stub.ingestMessage(message),
      updateMessageStatus: async () => {}, updateAttachmentState: async () => {}, updatePolicyState: async () => {}, markConversationRead: async () => {}, pruneMessages: async () => 0
    } };
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("synthetic-app-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map(b => b.toString(16).padStart(2, "0")).join("");
    const request = (signed: boolean) => new Request("https://pilot.test/webhooks/meta/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", ...(signed ? { "x-hub-signature-256": `sha256=${signature}` } : {}) }, body: raw });
    const webhookEnv = { META_WEBHOOK_VERIFY_TOKEN: "synthetic-verify-token", META_APP_SECRET: "synthetic-app-secret" };
    expect((await handleMetaWhatsAppWebhook(request(false), webhookEnv, persistence))?.status).toBe(401);
    expect((await handleMetaWhatsAppWebhook(request(true), webhookEnv, persistence))?.status).toBe(200);
    expect((await handleMetaWhatsAppWebhook(request(true), webhookEnv, persistence))?.status).toBe(200);
    const history = await f.stub.getConversationHistory({ conversationRef: f.args.conversationRef });
    expect(history?.messages).toHaveLength(3);
    expect(history?.messages.find(m => m.messageRef === "fixture-form-complete")?.flowSubmission).toMatchObject({ status: "completed", form: { kind: "visit", answers: { customer_name: "Synthetic Tester" } } });
    expect(JSON.stringify(history)).not.toContain(token);
  });
});
