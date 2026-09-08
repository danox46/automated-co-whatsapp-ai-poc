import { describe, expect, it, vi } from "vitest";
import { createPilotOnboardingHandler, type PilotOnboardingDependencies } from "./pilotOnboarding.js";
import { randomBase64Url } from "./pilotCrypto.js";
import type { PilotInstallationRecord, PilotInviteRecord } from "./pilotInstallationStore.js";

const origin = "https://pilot.example.workers.dev";

function createFixture() {
  const invites = new Map<string, PilotInviteRecord>();
  const states = new Map<string, string>();
  const installations = new Map<string, PilotInstallationRecord>();
  let nextInvite = "invite_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  let orphanedConnectedSeat = false;
  const registry: PilotOnboardingDependencies["registry"] = {
    async createInvite(input, now = new Date()) {
      if (orphanedConnectedSeat) throw new Error("tenant already has a cohort seat");
      const token = nextInvite;
      invites.set(token, { ...input, createdAt: now.toISOString() });
      nextInvite = `${nextInvite}x`;
      return token;
    },
    async rotateInvite(input, now = new Date()) {
      const pending = [...invites.entries()].find(([, invite]) =>
        invite.tenantId === input.tenantId && invite.cohortRole === input.cohortRole && !invite.usedAt
      );
      if (!pending) throw new Error("missing pending invite");
      pending[1].usedAt = now.toISOString();
      const token = nextInvite;
      invites.set(token, { ...input, createdAt: now.toISOString() });
      nextInvite = `${nextInvite}x`;
      return token;
    },
    async getInvite(token, now = new Date()) {
      const invite = invites.get(token);
      return invite && !invite.usedAt && invite.expiresAt > now.toISOString() ? { ...invite } : null;
    },
    async beginSession(token, state) {
      if (!invites.has(token)) throw new Error("missing invite");
      states.set(token, state);
    },
    async consumeSession(token, state, now = new Date()) {
      if (states.get(token) !== state) return null;
      states.delete(token);
      return this.getInvite(token, now);
    },
    async completeInstallation(token, installation, completedAt = new Date()) {
      installations.set(installation.tenantId, structuredClone(installation));
      const invite = invites.get(token);
      if (invite) invite.usedAt = completedAt.toISOString();
    },
    async getInstallation(tenantId) {
      return structuredClone(installations.get(tenantId) ?? null);
    },
    async reconcileOrphanedConnectedSeat(tenantId) {
      if (installations.has(tenantId) || !orphanedConnectedSeat) return false;
      orphanedConnectedSeat = false;
      return true;
    },
    async resolveTenantForWaba(wabaId) {
      return [...installations.values()].find((item) => item.wabaId === wabaId)?.tenantId ?? null;
    },
    async disconnect(tenantId) {
      const installation = installations.get(tenantId);
      if (!installation) return null;
      installation.status = "disconnected";
      return structuredClone(installation);
    },
    async deleteInstallation(tenantId) {
      const installation = installations.get(tenantId);
      installations.delete(tenantId);
      return structuredClone(installation ?? null);
    },
    sanitize(installation) {
      return {
        tenantId: installation.tenantId,
        ...(installation.verifiedName ? { verifiedName: installation.verifiedName } : {}),
        ...(installation.tokenExpiresAt ? { tokenExpiresAt: installation.tokenExpiresAt } : {}),
        connectedAt: installation.connectedAt,
        webhookSubscribedAt: installation.webhookSubscribedAt,
        status: installation.status,
        providerAssetsBound: true
      };
    }
  };
  const graph: PilotOnboardingDependencies["graph"] = {
    exchangeEmbeddedSignupCode: vi.fn(async () => ({ accessToken: "provider-access-token" })),
    verifyPhoneBelongsToWaba: vi.fn(async (_token, _waba, phoneNumberId) => ({
      id: phoneNumberId,
      verifiedName: "Pilot Business"
    })),
    subscribeApp: vi.fn(async () => undefined),
    unsubscribeApp: vi.fn(async () => undefined),
    verifyApprovedTemplate: vi.fn(async (_token, _waba, name, languageCode) => ({
      name,
      category: "UTILITY",
      languageCode
    })),
    sendText: vi.fn(async () => ({ messageRef: "wamid.text", status: "accepted" as const })),
    sendTemplate: vi.fn(async () => ({ messageRef: "wamid.template", status: "accepted" as const }))
  };
  const deleteConversationData = vi.fn(async () => ({ conversationsDeleted: 1 }));
  const createAuthorizationSession = vi.fn(async () => ({
    rawSession: "oauth_session_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345",
    expiresAt: 1_789_662_400
  }));
  const revokeAuthorizationSessions = vi.fn(async () => undefined);
  const registerSandboxRecipients = vi.fn(async () => undefined);
  const fixedNow = new Date("2026-09-07T12:00:00.000Z");
  const handler = createPilotOnboardingHandler({
    META_APP_ID: "public-app-id",
    META_APP_SECRET: "private-app-secret",
    META_GRAPH_API_VERSION: "v25.0",
    META_EMBEDDED_SIGNUP_CONFIG_ID: "public-config-id",
    INSTALLATION_ENCRYPTION_KEY: randomBase64Url(32),
    PILOT_ADMIN_TOKEN: "owner-admin-token",
    PUBLIC_ORIGIN: origin
  }, {
    registry,
    graph,
    deleteConversationData,
    createAuthorizationSession,
    revokeAuthorizationSessions,
    sandbox: {
      tenantId: "automated-co-sandbox",
      wabaId: "5550002001",
      phoneNumberId: "5550001001",
      accessToken: "sandbox_access_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      allowedRecipients: ["15550000001"]
    },
    registerSandboxRecipients,
    now: () => fixedNow
  });
  return {
    handler,
    registry,
    graph,
    deleteConversationData,
    createAuthorizationSession,
    revokeAuthorizationSessions,
    registerSandboxRecipients,
    installations,
    markOrphanedConnectedSeat() {
      orphanedConnectedSeat = true;
    }
  };
}

function adminRequest(path: string, method: string, body?: unknown, token = "owner-admin-token") {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

describe("closed-pilot onboarding", () => {
  it("connects an app-owned sandbox without Embedded Signup and never exposes its secrets", async () => {
    const fixture = createFixture();
    const invitationResponse = await fixture.handler.fetch(adminRequest(
      "/admin/pilot/sandbox/invitations",
      "POST",
      { label: "Automated & CO owner sandbox", expiresInHours: 24 }
    ));
    expect(invitationResponse?.status).toBe(201);
    const invitation = await invitationResponse?.json() as { invitationUrl: string; tenantId: string };
    expect(invitation.tenantId).toBe("automated-co-sandbox");

    const redirect = await fixture.handler.fetch(new Request(invitation.invitationUrl));
    expect(redirect?.status).toBe(303);
    expect(redirect?.headers.get("location")).toBe(`${origin}/pilot/whatsapp/sandbox`);
    const cookie = redirect?.headers.get("set-cookie")?.split(";")[0] as string;

    const connected = await fixture.handler.fetch(new Request(`${origin}/pilot/whatsapp/sandbox`, {
      headers: { Cookie: cookie }
    }));
    const html = await connected?.text() as string;
    expect(connected?.status).toBe(200);
    expect(connected?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(connected?.headers.getSetCookie()).toHaveLength(2);
    expect(html).toContain(`${origin}/mcp`);
    expect(html).not.toContain("15550000001");
    expect(html).not.toContain("5550001001");
    expect(html).not.toContain("sandbox_access_token");
    expect(fixture.graph.verifyPhoneBelongsToWaba).toHaveBeenCalledWith(
      "sandbox_access_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "5550002001",
      "5550001001"
    );
    expect(fixture.registerSandboxRecipients).toHaveBeenCalledWith(
      "automated-co-sandbox",
      "5550001001",
      ["15550000001"],
      new Date("2026-09-07T12:00:00.000Z")
    );
    expect(fixture.installations.get("automated-co-sandbox")?.status).toBe("connected");

    const replay = await fixture.handler.fetch(new Request(invitation.invitationUrl));
    expect(replay?.status).toBe(410);
  });

  it("rotates an unused sandbox invitation without exposing provider configuration", async () => {
    const fixture = createFixture();
    const originalResponse = await fixture.handler.fetch(adminRequest(
      "/admin/pilot/sandbox/invitations",
      "POST",
      { label: "Automated & CO owner sandbox", expiresInHours: 24 }
    ));
    const original = await originalResponse?.json() as { invitationUrl: string };

    const rotatedResponse = await fixture.handler.fetch(adminRequest(
      "/admin/pilot/sandbox/invitations/rotate",
      "POST",
      { label: "Automated & CO owner sandbox", expiresInHours: 24 }
    ));
    expect(rotatedResponse?.status).toBe(201);
    const rotatedText = await rotatedResponse?.text() as string;
    expect(JSON.parse(rotatedText)).toMatchObject({
      ok: true,
      tenantId: "automated-co-sandbox",
      cohortRole: "internal",
      rotated: true
    });
    expect(rotatedText).not.toContain("15550000001");
    expect(rotatedText).not.toContain("5550001001");
    expect(rotatedText).not.toContain("sandbox_access_token");

    const oldInvitation = await fixture.handler.fetch(new Request(original.invitationUrl));
    expect(oldInvitation?.status).toBe(410);
  });

  it("repairs an orphaned connected sandbox seat before creating a replacement invitation", async () => {
    const fixture = createFixture();
    fixture.markOrphanedConnectedSeat();

    const response = await fixture.handler.fetch(adminRequest(
      "/admin/pilot/sandbox/invitations",
      "POST",
      { label: "Automated & CO owner sandbox", expiresInHours: 24 }
    ));

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      tenantId: "automated-co-sandbox",
      cohortRole: "internal"
    });
  });

  it("creates a one-time invite, strips it from the URL, and completes verified signup", async () => {
    const fixture = createFixture();
    const unauthorized = await fixture.handler.fetch(adminRequest(
      "/admin/pilot/invitations", "POST", { tenantId: "pilot-one", label: "Pilot One", cohortRole: "client" }, "wrong"
    ));
    expect(unauthorized?.status).toBe(401);

    const invitationResponse = await fixture.handler.fetch(adminRequest(
      "/admin/pilot/invitations",
      "POST",
      { tenantId: "pilot-one", label: "Pilot One", cohortRole: "client", expiresInHours: 24 }
    ));
    expect(invitationResponse?.status).toBe(201);
    const invitation = await invitationResponse?.json() as { invitationUrl: string };

    const redirect = await fixture.handler.fetch(new Request(invitation.invitationUrl));
    expect(redirect?.status).toBe(303);
    expect(redirect?.headers.get("location")).toBe(`${origin}/pilot/whatsapp/connect`);
    const cookie = redirect?.headers.get("set-cookie")?.split(";")[0] as string;
    expect(cookie).not.toContain("private-app-secret");

    const page = await fixture.handler.fetch(new Request(`${origin}/pilot/whatsapp/connect`, {
      headers: { Cookie: cookie }
    }));
    const html = await page?.text() as string;
    expect(page?.status).toBe(200);
    expect(page?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("Pilot One");
    expect(html).not.toContain("private-app-secret");
    expect(html).not.toContain(new URL(invitation.invitationUrl).searchParams.get("invite") as string);
    const configMatch = /const cfg=(\{.*?\});let/u.exec(html);
    expect(configMatch).not.toBeNull();
    const config = JSON.parse(configMatch?.[1] as string) as { state: string };

    const callbackBody = {
      state: config.state,
      code: "A2345678901234567890",
      wabaId: "100200300",
      phoneNumberId: "400500600"
    };
    const wrongOrigin = await fixture.handler.fetch(new Request(`${origin}/pilot/whatsapp/callback`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify(callbackBody)
    }));
    expect(wrongOrigin?.status).toBe(403);

    const callback = await fixture.handler.fetch(new Request(`${origin}/pilot/whatsapp/callback`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(callbackBody)
    }));
    expect(callback?.status).toBe(200);
    await expect(callback?.json()).resolves.toMatchObject({
      ok: true,
      status: "connected",
      tenantId: "pilot-one",
      providerAssetsBound: true
    });
    const stored = fixture.installations.get("pilot-one") as PilotInstallationRecord;
    expect(stored.encryptedAccessToken.ciphertext).not.toContain("provider-access-token");
    expect(fixture.graph.subscribeApp).toHaveBeenCalledWith("provider-access-token", "100200300");

    const replay = await fixture.handler.fetch(new Request(`${origin}/pilot/whatsapp/callback`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(callbackBody)
    }));
    expect(replay?.status).toBe(409);
  });

  it("returns only sanitized installation status and enforces disconnect before deletion", async () => {
    const fixture = createFixture();
    fixture.installations.set("pilot-two", {
      tenantId: "pilot-two",
      wabaId: "111222333",
      phoneNumberId: "444555666",
      displayPhoneNumber: "+57 private",
      encryptedAccessToken: { ciphertext: "not-used", iv: "not-used", version: 1 },
      connectedAt: "2026-09-07T12:00:00.000Z",
      webhookSubscribedAt: "2026-09-07T12:00:00.000Z",
      status: "connected"
    });

    const status = await fixture.handler.fetch(adminRequest("/admin/pilot/installations/pilot-two", "GET"));
    const statusText = await status?.text() as string;
    expect(status?.status).toBe(200);
    expect(statusText).not.toContain("111222333");
    expect(statusText).not.toContain("444555666");
    expect(statusText).not.toContain("+57 private");

    const deletion = await fixture.handler.fetch(adminRequest(
      "/admin/pilot/installations/pilot-two",
      "DELETE",
      { confirmation: "DELETE pilot-two" }
    ));
    expect(deletion?.status).toBe(409);
    expect(fixture.deleteConversationData).not.toHaveBeenCalled();
  });

  it("rotates an unused invitation without allocating another cohort seat", async () => {
    const fixture = createFixture();
    const originalResponse = await fixture.handler.fetch(adminRequest(
      "/admin/pilot/invitations",
      "POST",
      { tenantId: "pilot-rotate", label: "Pilot Rotate", cohortRole: "client", expiresInHours: 24 }
    ));
    const original = await originalResponse?.json() as { invitationUrl: string };

    const rotatedResponse = await fixture.handler.fetch(adminRequest(
      "/admin/pilot/invitations/rotate",
      "POST",
      { tenantId: "pilot-rotate", label: "Pilot Rotate", cohortRole: "client", expiresInHours: 24 }
    ));
    expect(rotatedResponse?.status).toBe(201);
    await expect(rotatedResponse?.json()).resolves.toMatchObject({
      ok: true,
      tenantId: "pilot-rotate",
      rotated: true
    });

    const oldInvitation = await fixture.handler.fetch(new Request(original.invitationUrl));
    expect(oldInvitation?.status).toBe(410);
  });
});
