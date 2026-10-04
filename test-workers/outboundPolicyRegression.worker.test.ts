import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Base64Url } from "../src/meta/pilotCrypto.js";

async function conversationFixture() {
  const tenantId = `regression_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const stub = env.CONVERSATIONS.getByName(tenantId);
  await stub.initializeTenant(tenantId);
  await stub.ingestMessage({
    conversationRef: "expired", providerAccountRef: "123456789", providerParticipantRef: "15550000001",
    messageRef: "wamid.fixture", direction: "inbound", kind: "text", text: "fixture",
    occurredAt: "2024-01-01T00:00:00.000Z", status: "received"
  });
  await stub.setConversationTemplateConsent({
    conversationRef: "expired", categories: ["UTILITY"], purposes: ["support"],
    policyRevision: "v1", updatedAt: "2024-01-01T00:00:00.000Z"
  });
  return { stub, tenantId };
}

describe("Worker storage policy regressions", () => {
  for (const operation of ["single", "tenant", "retention"] as const) {
    it(`deletes dependent consent rows for ${operation}, retaining the other tenant`, async () => {
      const { stub } = await conversationFixture();
      const other = await conversationFixture();
      if (operation === "single") await expect(stub.deleteConversationData("expired")).resolves.toMatchObject({ conversationsDeleted: 1 });
      if (operation === "tenant") await expect(stub.deleteAllConversationData()).resolves.toMatchObject({ conversationsDeleted: 1 });
      if (operation === "retention") {
        await stub.configureRetention({ messageRetentionDays: 90, inactiveConversationRetentionDays: 365, pendingStatusRetentionDays: 7, pruneIntervalHours: 24 }, "2026-01-01T00:00:00.000Z");
        await expect(stub.runRetention("2026-01-01T00:00:00.000Z")).resolves.toMatchObject({ conversationsDeleted: 1, nextRunAt: "2026-01-02T00:00:00.000Z" });
      }
      expect(await stub.getConversationEnforcementState("expired")).toBeNull();
      expect((await stub.getOutboundPolicy("expired")).consentedTemplatePurposes).toEqual([]);
      expect(await other.stub.getConversationEnforcementState("expired")).not.toBeNull();
      expect((await other.stub.getOutboundPolicy("expired")).consentedTemplatePurposes).toEqual(["support"]);
    });
  }
  it("requires current template approval, exact attributes and both consent types inside reservation", async () => {
    const { stub } = await conversationFixture();
    const template = { name: "support_update", category: "UTILITY", purpose: "support", languageCode: "en_US" };
    await stub.upsertApprovedTemplate({ ...template, enabled: true });
    const reservation = {
      conversationRef: "expired", kind: "approved_template" as const,
      idempotencyKey: "worker-template-key", requestFingerprint: await sha256Base64Url("fixture"),
      expectedPolicyRevision: "v1", expectedProviderAccountRef: "123456789",
      now: "2026-01-01T00:00:00.000Z", template
    };
    await stub.upsertApprovedTemplate({ ...template, enabled: false });
    expect(await stub.reserveOutboundDispatch(reservation)).toEqual({ status: "blocked", reason: "template_unavailable" });
    await stub.upsertApprovedTemplate({ ...template, enabled: true, languageCode: "es_CO" });
    expect(await stub.reserveOutboundDispatch(reservation)).toEqual({ status: "blocked", reason: "state_changed" });
    await stub.upsertApprovedTemplate({ ...template, enabled: true });
    await stub.setConversationTemplateConsent({ conversationRef: "expired", categories: ["UTILITY"], purposes: [], policyRevision: "v1", updatedAt: reservation.now });
    expect(await stub.reserveOutboundDispatch(reservation)).toEqual({ status: "blocked", reason: "template_consent_required" });
    await stub.setConversationTemplateConsent({ conversationRef: "expired", categories: ["UTILITY"], purposes: ["support"], policyRevision: "v1", updatedAt: reservation.now });
    expect(await stub.reserveOutboundDispatch(reservation)).toMatchObject({ status: "ready" });
    await stub.cancelUnsentOutboundDispatch({ idempotencyKey: reservation.idempotencyKey, requestFingerprint: await sha256Base64Url("wrong-holder") });
    expect(await stub.getOutboundDispatchResult(reservation)).toEqual({ status: "blocked", reason: "in_progress" });
    await stub.cancelUnsentOutboundDispatch(reservation);
    expect(await stub.getOutboundDispatchResult(reservation)).toBeNull();
    expect(await stub.reserveOutboundDispatch(reservation)).toMatchObject({ status: "ready" });
  });
});
