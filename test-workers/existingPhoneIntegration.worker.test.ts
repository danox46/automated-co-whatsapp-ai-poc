import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPilotInstallationRegistry, type PilotInstallationRecord } from "../src/meta/pilotInstallationStore.js";
import { createDurableOAuthState } from "../src/oauth/durableAuthorizationStore.js";

describe("existing phone with distinct Messaging Accounts", () => {
  it("persists the new onboarding mode across rotation/reopen and isolates routes, credentials, sessions and history", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const cohortName = `existing-phone:${suffix}`;
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS, cohortName);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 86400000).toISOString();
    const original: PilotInstallationRecord = {
      tenantId: `original_${suffix}`, wabaId: crypto.getRandomValues(new Uint32Array(2)).join("").padEnd(12, "1"),
      phoneNumberId: "1428474000000", encryptedAccessToken: { version: 1, ciphertext: "original-ciphertext", iv: "original_iv" },
      connectedAt: now.toISOString(), webhookSubscribedAt: now.toISOString(), status: "connected"
    };
    const firstInvite = await registry.createInvite({ tenantId: original.tenantId, label: "Original integration",
      cohortRole: "internal", expiresAt }, now);
    await registry.completeInstallation(firstInvite, original, now);
    const state = createDurableOAuthState(env.OAUTH_STATE);
    const originalSession = await state.createPilotSession(original.tenantId, ["openid", "whatsapp.conversations.read"]);
    const history = env.CONVERSATIONS.getByName(original.tenantId);
    await history.initializeTenant(original.tenantId);
    await history.ingestMessage({ conversationRef: "conv_existing_phone_original", providerAccountRef: original.phoneNumberId,
      providerParticipantRef: "15550000001", messageRef: "existing-phone-original-message", direction: "inbound",
      kind: "text", text: "Synthetic original-only history", occurredAt: now.toISOString(), status: "received" });
    const originalHistory = await history.getConversationHistory({ conversationRef: "conv_existing_phone_original" });

    const second = { ...original, tenantId: `integration_${suffix}`, wabaId: `${original.wabaId}2`,
      encryptedAccessToken: { version: 1 as const, ciphertext: "new-ma-ciphertext", iv: "new_ma_iv" } };
    const pending = await registry.createInvite({ tenantId: second.tenantId, label: "Integration before selection",
      cohortRole: "client", expiresAt, onboarding: { flow: "existing_account" } }, now);
    const onboarding = { flow: "existing_account" as const,
      expectedAssets: { wabaId: second.wabaId, phoneNumberId: second.phoneNumberId } };
    const rotated = await registry.rotateInvite({ tenantId: second.tenantId, label: "Integration after selection",
      cohortRole: "client", expiresAt, onboarding }, now);
    const reopened = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS, cohortName);
    expect(await reopened.getInvite(pending, now)).toBeNull();
    expect((await reopened.getInvite(rotated, now))?.onboarding).toEqual(onboarding);
    expect((await reopened.getInvite(rotated, now))?.reauthorization).toBeUndefined();
    await reopened.completeInstallation(rotated, second, now);
    expect(await reopened.getInstallation(original.tenantId)).toEqual(original);
    expect(await reopened.getInstallation(second.tenantId)).toEqual(second);
    expect(await reopened.resolveTenantForWaba(original.wabaId)).toBe(original.tenantId);
    expect(await reopened.resolveTenantForWaba(second.wabaId)).toBe(second.tenantId);
    expect(await reopened.getInvite(rotated, now)).toBeNull();
    expect((await state.resolvePilotSession(originalSession.rawSession))?.tenantId).toBe(original.tenantId);
    expect(await history.getConversationHistory({ conversationRef: "conv_existing_phone_original" })).toEqual(originalHistory);
    const secondHistory = env.CONVERSATIONS.getByName(second.tenantId);
    await secondHistory.initializeTenant(second.tenantId);
    expect(await secondHistory.getConversationHistory({ conversationRef: "conv_existing_phone_original" })).toBeNull();
    expect(await env.PILOT_INSTALLATIONS.getByName(cohortName).listPilotSeats("client")).toHaveLength(1);
    expect(await env.PILOT_INSTALLATIONS.getByName(cohortName).listPilotSeats("internal")).toHaveLength(1);
  });
});
