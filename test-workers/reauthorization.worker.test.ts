import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPilotInstallationRegistry, type PilotInstallationRecord } from "../src/meta/pilotInstallationStore.js";
import { createDurableOAuthState } from "../src/oauth/durableAuthorizationStore.js";

async function fixture() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const cohort = `reauth-cohort:${suffix}`;
  const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS, cohort);
  const now = new Date();
  const installation: PilotInstallationRecord = { tenantId: `renew_${suffix}`,
    wabaId: crypto.getRandomValues(new Uint32Array(2)).join("").padEnd(12, "1"), phoneNumberId: "1428474000000",
    encryptedAccessToken: { version: 1, ciphertext: "original-encrypted-token", iv: "original_nonce" },
    connectedAt: now.toISOString(), webhookSubscribedAt: now.toISOString(), status: "connected" };
  const token = await registry.createInvite({ tenantId: installation.tenantId, label: "Existing fixture", cohortRole: "internal",
    expiresAt: new Date(now.getTime() + 86400000).toISOString() }, now);
  await registry.completeInstallation(token, installation, now);
  return { registry, installation, now, cohort };
}

describe("existing installation reauthorization", () => {
  it("does not consume another cohort seat and keeps sessions/history/route stable across credential renewal", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) await f.registry.createInvite({ tenantId: `full_${f.installation.tenantId}_${i}`,
      label: "Other client", cohortRole: "client", expiresAt: new Date(f.now.getTime() + 86400000).toISOString() }, f.now);
    const state = createDurableOAuthState(env.OAUTH_STATE);
    const session = await state.createPilotSession(f.installation.tenantId, ["openid", "whatsapp.conversations.read"]);
    const history = env.CONVERSATIONS.getByName(f.installation.tenantId);
    await history.initializeTenant(f.installation.tenantId);
    await history.ingestMessage({ conversationRef: "conv_renew_original", providerAccountRef: f.installation.phoneNumberId,
      providerParticipantRef: "15550000001", messageRef: "original-renew-test-message", direction: "inbound",
      kind: "text", text: "Synthetic preserved history", occurredAt: f.now.toISOString(), status: "received" });
    const snapshot = await history.getConversationHistory({ conversationRef: "conv_renew_original" });
    const invite = await f.registry.createReauthorizationInvite({ tenantId: f.installation.tenantId,
      label: "Renew fixture", expiresAt: new Date(f.now.getTime() + 3600000).toISOString() }, f.now);
    const reopened = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS, f.cohort);
    expect((await reopened.getInvite(invite, f.now))?.reauthorization).toEqual({
      wabaId: f.installation.wabaId, phoneNumberId: f.installation.phoneNumberId, credentialIv: "original_nonce" });
    const candidate = { ...f.installation, encryptedAccessToken: { version: 1 as const, ciphertext: "renewed-encrypted-token", iv: "renewed_nonce" } };
    expect(await reopened.completeReauthorization(invite, candidate, f.now)).toBe(true);
    expect(await reopened.getInvite(invite, f.now)).toBeNull();
    expect((await reopened.getInstallation(f.installation.tenantId))?.encryptedAccessToken).toEqual(candidate.encryptedAccessToken);
    expect(await reopened.getWabaBindingOwner(f.installation.wabaId)).toBe(f.installation.tenantId);
    expect(await history.getConversationHistory({ conversationRef: "conv_renew_original" })).toEqual(snapshot);
    expect((await state.resolvePilotSession(session.rawSession))?.tenantId).toBe(f.installation.tenantId);
    expect(await env.PILOT_INSTALLATIONS.getByName(f.cohort).listPilotSeats("client")).toHaveLength(3);
    expect(await env.PILOT_INSTALLATIONS.getByName(f.cohort).listPilotSeats("internal")).toHaveLength(1);
    expect(await reopened.completeReauthorization(invite, candidate, f.now)).toBe(false);
  });

  it("allows only one winner when two old invitations try replacing the same credential", async () => {
    const f = await fixture();
    const input = { tenantId: f.installation.tenantId, label: "Renew fixture", expiresAt: new Date(f.now.getTime() + 3600000).toISOString() };
    const invites = await Promise.all([f.registry.createReauthorizationInvite(input, f.now), f.registry.createReauthorizationInvite(input, f.now)]);
    const candidates = invites.map((_, index) => ({ ...f.installation,
      encryptedAccessToken: { version: 1 as const, ciphertext: `candidate-${index}`, iv: `candidate_nonce_${index}` } }));
    const result = await Promise.all(invites.map((token, i) => f.registry.completeReauthorization(token, candidates[i], f.now)));
    expect(result.filter(Boolean)).toHaveLength(1);
    const current = await f.registry.getInstallation(f.installation.tenantId);
    expect(current?.encryptedAccessToken).toEqual(candidates[result.findIndex(Boolean)].encryptedAccessToken);
    expect(current?.connectedAt).toBe(f.installation.connectedAt);
  });

  it("rejects changed assets, expired invitations and a disconnected installation", async () => {
    const f = await fixture();
    const token = await f.registry.createReauthorizationInvite({ tenantId: f.installation.tenantId, label: "Renew",
      expiresAt: new Date(f.now.getTime() + 3600000).toISOString() }, f.now);
    const candidate = { ...f.installation, encryptedAccessToken: { version: 1 as const, ciphertext: "replacement", iv: "replacement_nonce" } };
    expect(await f.registry.completeReauthorization(token, { ...candidate, phoneNumberId: "999999999999" }, f.now)).toBe(false);
    expect(await f.registry.completeReauthorization(token, candidate, new Date(f.now.getTime() + 3600001))).toBe(false);
    await f.registry.disconnect(f.installation.tenantId, f.now);
    expect(await f.registry.completeReauthorization(token, candidate, f.now)).toBe(false);
    expect((await f.registry.getInstallation(f.installation.tenantId))?.encryptedAccessToken).toEqual(f.installation.encryptedAccessToken);
  });
});
