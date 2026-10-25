import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { persistMetaConversationEvents, opaqueConversationRef } from "../src/meta/conversationEvents.js";
import { flowToken } from "../src/meta/flowResponses.js";
import { sha256Base64Url } from "../src/meta/pilotCrypto.js";

async function fixture() {
  const tenantId = `flow_${crypto.randomUUID().replace(/-/gu, "").slice(0, 12)}`;
  const stub = env.CONVERSATIONS.getByName(tenantId);
  await stub.initializeTenant(tenantId);
  const conversationRef = await opaqueConversationRef(tenantId, "15550000002", "15550000001", "synthetic-reference-secret");
  await stub.ingestMessage({ conversationRef, providerAccountRef: "15550000002", providerParticipantRef: "15550000001", messageRef: "fixture-inbound", direction: "inbound", kind: "text", text: "synthetic", occurredAt: "2026-10-25T01:00:00.000Z", status: "received" });
  const idempotencyKey = "original-flow-intent";
  const requestFingerprint = await sha256Base64Url("synthetic-flow-body");
  const token = await flowToken("synthetic-reference-secret", tenantId, conversationRef, idempotencyKey);
  const tokenHash = await sha256Base64Url(token);
  const launch = { tokenHash, conversationRef, kind: "visit" as const, idempotencyKey, requestFingerprint, createdAt: "2026-10-25T01:01:00.000Z", expiresAt: "2026-11-01T01:01:00.000Z" };
  const reservation = { conversationRef, kind: "free_form_reply" as const, idempotencyKey, requestFingerprint, expectedPolicyRevision: "v1", expectedProviderAccountRef: "15550000002", now: launch.createdAt, notAfter: "2026-10-26T01:00:00.000Z" };
  expect(await stub.reserveOutboundDispatch(reservation)).toMatchObject({ status: "ready" });
  await stub.registerFlowLaunch(launch);
  await stub.completeOutboundDispatch({ ...launch, providerAccountRef: "15550000002", providerParticipantRef: "15550000001", messageRef: "fixture-flow-launch", providerStatus: "accepted", kind: "interactive", text: "Agendar visita", occurredAt: launch.createdAt });
  await stub.bindFlowLaunchMessage({ tokenHash, conversationRef, messageRef: "fixture-flow-launch" });
  const body = { flow_token: token, source: "visit_schedule_flow", customer_name: "Synthetic Tester", phone: "+15550000001", visit_date: "2026-11-02", visit_time: "10_00_am", notes: "Test" };
  async function receive(messageRef: string, override: Record<string, unknown> = {}, sender = "15550000001", context = "fixture-flow-launch", timestamp = "1792890180") {
    const payload = { entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "15550000002" }, messages: [{ from: sender, id: messageRef, timestamp, type: "interactive", context: { id: context }, interactive: { type: "nfm_reply", nfm_reply: { body: "Sent", response_json: JSON.stringify({ ...body, ...override }) } } }] } }] }] };
    await persistMetaConversationEvents(payload, { tenantId, conversationRefSecret: "synthetic-reference-secret", writer: {
      ingestMessage: async ({ tenantId: _tenant, ...message }) => stub.ingestMessage(message),
      updateMessageStatus: async () => {}, updateAttachmentState: async () => {}, updatePolicyState: async () => {}, markConversationRead: async () => {}, pruneMessages: async () => 0
    } });
  }
  return { stub, tenantId, conversationRef, token, tokenHash, launch, receive };
}

describe("durable Flow completion correlation", () => {
  it("cannot redeem another tenant's Flow token even with an otherwise valid form", async () => {
    const owner = await fixture();
    const other = await fixture();
    await other.receive("cross-tenant-token", { flow_token: owner.token });
    expect((await other.stub.getConversationHistory({ conversationRef: other.conversationRef }))?.messages.find(m => m.messageRef === "cross-tenant-token")?.flowSubmission).toEqual({ status: "unmatched" });
    await owner.receive("owner-response");
    expect((await owner.stub.getConversationHistory({ conversationRef: owner.conversationRef }))?.messages.find(m => m.messageRef === "owner-response")?.flowSubmission).toMatchObject({ status: "completed" });
  });
  it("retains structured answers across a fresh stub and deduplicates both webhook IDs and repeated submissions", async () => {
    const f = await fixture();
    await f.receive("fixture-form-response");
    await f.receive("fixture-form-response");
    await f.receive("fixture-second-submission");
    const reopened = env.CONVERSATIONS.getByName(f.tenantId);
    const history = await reopened.getConversationHistory({ conversationRef: f.conversationRef });
    expect(history?.messages).toHaveLength(4);
    expect(history?.messages.find(m => m.messageRef === "fixture-form-response")?.flowSubmission).toMatchObject({ status: "completed", form: { kind: "visit", answers: { visit_date: "2026-11-02", customer_name: "Synthetic Tester" } } });
    expect(history?.messages.find(m => m.messageRef === "fixture-second-submission")?.flowSubmission).toEqual({ status: "duplicate" });
    expect(JSON.stringify(history)).not.toContain(f.token);
    expect(JSON.stringify(history)).not.toContain(f.tokenHash);
    expect(JSON.stringify(history)).not.toContain("response_json");
  });
  it("does not consume an intent on wrong sender, context, schema or expiry", async () => {
    const f = await fixture();
    await f.receive("wrong-context", {}, "15550000001", "unrelated-message");
    await f.receive("wrong-sender", {}, "15550000009");
    await f.receive("invalid-fields", { unexpected: "not stored" });
    await f.receive("expired", {}, "15550000001", "fixture-flow-launch", "1793584981");
    await f.receive("valid-after-rejections");
    const history = await f.stub.getConversationHistory({ conversationRef: f.conversationRef });
    expect(history?.messages.find(m => m.messageRef === "wrong-context")?.flowSubmission).toEqual({ status: "unmatched" });
    expect(history?.messages.find(m => m.messageRef === "invalid-fields")?.flowSubmission).toEqual({ status: "invalid" });
    expect(history?.messages.find(m => m.messageRef === "expired")?.flowSubmission).toEqual({ status: "unmatched" });
    expect(history?.messages.find(m => m.messageRef === "valid-after-rejections")?.flowSubmission).toMatchObject({ status: "completed" });
    expect(JSON.stringify(history)).not.toContain("not stored");
  });
  for (const operation of ["conversation", "tenant", "prune", "retention"] as const) {
    it(`removes Flow answers and correlation data on ${operation} cleanup`, async () => {
      const f = await fixture();
      await f.receive("fixture-form-response");
      if (operation === "conversation") await f.stub.deleteConversationData(f.conversationRef);
      if (operation === "tenant") await f.stub.deleteAllConversationData();
      if (operation === "prune") await f.stub.pruneMessages("2027-01-01T00:00:00.000Z");
      if (operation === "retention") {
        await f.stub.configureRetention({ messageRetentionDays: 90, inactiveConversationRetentionDays: 365, pendingStatusRetentionDays: 7, pruneIntervalHours: 24 }, "2027-02-01T00:00:00.000Z");
        await f.stub.runRetention("2027-02-01T00:00:00.000Z");
      }
      expect((await f.stub.getConversationHistory({ conversationRef: f.conversationRef }))?.messages ?? []).toEqual([]);
      // Recreate this conversation and reuse the old signed token: deleted
      // correlation must not authorize a new completion.
      await f.receive("after-cleanup-replay");
      const after = await f.stub.getConversationHistory({ conversationRef: f.conversationRef });
      expect(after?.messages[0].flowSubmission).toEqual({ status: "unmatched" });
    });
  }
});
