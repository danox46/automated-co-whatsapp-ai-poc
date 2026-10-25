import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPilotInstallationRegistry } from "../src/meta/pilotInstallationStore.js";
import { createDurableOAuthState } from "../src/oauth/durableAuthorizationStore.js";
import { sha256Base64Url } from "../src/meta/pilotCrypto.js";

describe("pilot installation Durable Objects", () => {
  it("switches and rolls back a sender without mixing routes, history or reply windows", async () => {
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    const digits = crypto.randomUUID().replace(/\D/g, "").padEnd(16, "7").slice(0, 16);
    const tenantId = `switch_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const original = {
      tenantId, wabaId: `1${digits}`, phoneNumberId: `2${digits}`,
      encryptedAccessToken: { ciphertext: "encrypted", iv: "nonce", version: 1 as const },
      connectedAt: "2026-10-25T12:00:00.000Z", webhookSubscribedAt: "2026-10-25T12:00:00.000Z",
      status: "connected" as const
    };
    const replacement = { ...original, wabaId: `3${digits}`, phoneNumberId: `4${digits}` };
    await registry.refreshInstallation(original);
    const conversations = env.CONVERSATIONS.getByName(tenantId);
    await conversations.initializeTenant(tenantId);
    await conversations.ingestMessage({
      conversationRef: "conv_before_switch", providerAccountRef: original.phoneNumberId,
      providerParticipantRef: "15550000001", messageRef: "wamid.before-switch", direction: "inbound",
      kind: "text", text: "Retain original evidence", occurredAt: original.connectedAt, status: "received"
    });

    await registry.refreshInstallation(replacement);
    expect(await registry.resolveTenantForWaba(original.wabaId)).toBeNull();
    expect(await registry.resolveTenantForWaba(replacement.wabaId)).toBe(tenantId);
    expect(await env.PILOT_INSTALLATIONS.getByName(`waba:${original.wabaId}`).getWabaRoute()).toBeNull();
    expect(await conversations.getConversationEnforcementState("conv_before_switch"))
      .toMatchObject({ providerAccountRef: original.phoneNumberId });
    expect(await conversations.reserveOutboundDispatch({
      conversationRef: "conv_before_switch", kind: "free_form_reply", idempotencyKey: "switch-reply-001",
      requestFingerprint: await sha256Base64Url("switch-reply"), expectedPolicyRevision: "v1",
      expectedProviderAccountRef: replacement.phoneNumberId, now: "2026-10-25T12:01:00.000Z",
      notAfter: "2026-10-26T12:00:00.000Z"
    })).toEqual({ status: "blocked", reason: "state_changed" });

    await registry.refreshInstallation(original);
    expect(await registry.resolveTenantForWaba(original.wabaId)).toBe(tenantId);
    expect(await registry.resolveTenantForWaba(replacement.wabaId)).toBeNull();
    expect(await registry.getInstallation(tenantId)).toMatchObject({ phoneNumberId: original.phoneNumberId });
    expect(await conversations.getConversationEnforcementState("conv_before_switch")).not.toBeNull();
  });

  it("ignores stale routes when installation is missing, moved or disconnected", async () => {
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    const digits = crypto.randomUUID().replace(/\D/g, "").padEnd(16, "8").slice(0, 16);
    const tenantId = `stale_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const staleWaba = `5${digits}`;
    const route = env.PILOT_INSTALLATIONS.getByName(`waba:${staleWaba}`);
    await route.putWabaRoute(tenantId);
    expect(await registry.resolveTenantForWaba(staleWaba)).toBeNull();
    const installation = {
      tenantId, wabaId: `6${digits}`, phoneNumberId: `7${digits}`,
      encryptedAccessToken: { ciphertext: "encrypted", iv: "nonce", version: 1 as const },
      connectedAt: "2026-10-25T12:00:00.000Z", webhookSubscribedAt: "2026-10-25T12:00:00.000Z",
      status: "connected" as const
    };
    await registry.refreshInstallation(installation);
    expect(await registry.resolveTenantForWaba(staleWaba)).toBeNull();
    await env.PILOT_INSTALLATIONS.getByName(`tenant:${tenantId}`).markInstallationDisconnected(installation.connectedAt);
    expect(await registry.resolveTenantForWaba(installation.wabaId)).toBeNull();
  });

  it("rejects a sender switch to another tenant's account without changing either installation", async () => {
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    const digits = crypto.randomUUID().replace(/\D/g, "").padEnd(16, "9").slice(0, 16);
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const first = {
      tenantId: `first_${suffix}`, wabaId: `8${digits}`, phoneNumberId: `9${digits}`,
      encryptedAccessToken: { ciphertext: "encrypted", iv: "nonce", version: 1 as const },
      connectedAt: "2026-10-25T12:00:00.000Z", webhookSubscribedAt: "2026-10-25T12:00:00.000Z",
      status: "connected" as const
    };
    const second = { ...first, tenantId: `second_${suffix}`, wabaId: `11${digits}`, phoneNumberId: `12${digits}` };
    await registry.refreshInstallation(first);
    await registry.refreshInstallation(second);
    await expect(registry.refreshInstallation({ ...first, wabaId: second.wabaId, phoneNumberId: second.phoneNumberId }))
      .rejects.toThrow("already bound to another tenant");
    expect(await registry.getInstallation(first.tenantId)).toMatchObject({ wabaId: first.wabaId });
    expect(await registry.resolveTenantForWaba(first.wabaId)).toBe(first.tenantId);
    expect(await registry.resolveTenantForWaba(second.wabaId)).toBe(second.tenantId);
  });

  it("consumes invitation sessions once and persists isolated tenant routing", async () => {
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantId = `pilot_${suffix}`;
    const now = new Date("2026-09-07T12:00:00.000Z");
    const expiresAt = "2026-09-08T12:00:00.000Z";
    const token = await registry.createInvite({ tenantId, label: "Worker pilot", cohortRole: "client", expiresAt }, now);

    await expect(registry.getInvite(token, now)).resolves.toMatchObject({ tenantId });
    await registry.beginSession(token, "state_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "2026-09-07T12:10:00.000Z", now);
    await expect(registry.consumeSession(token, "state_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", now))
      .resolves.toMatchObject({ tenantId });
    await expect(registry.consumeSession(token, "state_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", now))
      .resolves.toBeNull();

    const wabaId = `1${suffix.replace(/\D/g, "").padEnd(11, "7")}`;
    const phoneNumberId = `2${suffix.replace(/\D/g, "").padEnd(11, "8")}`;
    await registry.completeInstallation(token, {
      tenantId,
      wabaId,
      phoneNumberId,
      encryptedAccessToken: { ciphertext: "encrypted", iv: "nonce", version: 1 },
      connectedAt: now.toISOString(),
      webhookSubscribedAt: now.toISOString(),
      status: "connected"
    }, now);

    await expect(registry.resolveTenantForWaba(wabaId)).resolves.toBe(tenantId);
    const installation = await registry.getInstallation(tenantId);
    expect(installation).toMatchObject({ tenantId, wabaId, phoneNumberId, status: "connected" });
    expect(registry.sanitize(installation!)).not.toHaveProperty("encryptedAccessToken");
    await expect(registry.getInstallation(`other_${suffix}`)).resolves.toBeNull();
  });

  it("serves an authenticated one-time invite through the deployed Worker routes", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantId = `client_${suffix}`;
    const create = await exports.default.fetch(new Request("https://pilot.test/admin/pilot/invitations", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-pilot-admin-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ tenantId, label: "First pilot client", cohortRole: "client", expiresInHours: 24 })
    }));
    expect(create.status).toBe(201);
    const invitation = await create.json() as { invitationUrl: string };

    const redirect = await exports.default.fetch(new Request(invitation.invitationUrl, { redirect: "manual" }));
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe("https://pilot.test/pilot/whatsapp/connect");
    const cookie = redirect.headers.get("set-cookie")?.split(";")[0] as string;
    const page = await exports.default.fetch(new Request("https://pilot.test/pilot/whatsapp/connect", {
      headers: { Cookie: cookie }
    }));
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("https://connect.facebook.net");
    expect(html).toContain("First pilot client");
    expect(html).not.toContain(new URL(invitation.invitationUrl).searchParams.get("invite") as string);

    const health = await exports.default.fetch(new Request("https://pilot.test/health"));
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      pilotOnboardingConfigured: true,
      oauthConfigured: true,
      tenantRouting: "waba-sharded",
      outboundMessagingConfigured: true
    });
  });

  it("runs durable OAuth with PKCE and authorizes tenant-scoped MCP access", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const tenantId = `oauth_${suffix}`;
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    const oauth = createDurableOAuthState(env.OAUTH_STATE);
    const now = new Date();
    const invite = await registry.createInvite({
      tenantId,
      label: "OAuth pilot",
      cohortRole: "client",
      expiresAt: new Date(now.getTime() + 60_000).toISOString()
    }, now);
    const digits = suffix.replace(/\D/g, "").padEnd(12, "7");
    await registry.completeInstallation(invite, {
      tenantId,
      wabaId: `3${digits}`,
      phoneNumberId: `4${digits}`,
      encryptedAccessToken: { ciphertext: "encrypted", iv: "nonce", version: 1 },
      connectedAt: now.toISOString(),
      webhookSubscribedAt: now.toISOString(),
      status: "connected"
    }, now);
    const session = await oauth.createPilotSession(tenantId, [
      "openid",
      "whatsapp.policy.read",
      "whatsapp.connection.read",
      "whatsapp.conversations.read"
    ]);
    const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
    const challenge = await sha256Base64Url(verifier);
    const authorizeUrl = new URL("https://pilot.test/oauth/authorize");
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: "https://chatgpt.com/oauth/client.json",
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      resource: "https://pilot.test",
      scope: "openid whatsapp.policy.read whatsapp.connection.read whatsapp.conversations.read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-123"
    }).toString();
    const authorize = await exports.default.fetch(new Request(authorizeUrl, {
      redirect: "manual",
      headers: { Cookie: `__Host-wa_pilot_session=${session.rawSession}` }
    }));
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get("location") as string);
    expect(callback.searchParams.get("iss")).toBe("https://pilot.test");

    const token = await exports.default.fetch(new Request("https://pilot.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") as string,
        client_id: "https://chatgpt.com/oauth/client.json",
        redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        resource: "https://pilot.test",
        code_verifier: verifier
      })
    }));
    expect(token.status).toBe(200);
    const tokens = await token.json() as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);
    expect(tokens.refresh_token).toBeTruthy();

    const mcp = await exports.default.fetch(new Request("https://pilot.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    }));
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain("whatsapp_get_conversation_history");
  });

  it("atomically enforces the service window and durable send idempotency", async () => {
    const tenantId = `send_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const stub = env.CONVERSATIONS.getByName(tenantId);
    await stub.initializeTenant(tenantId);
    const inboundAt = "2026-09-07T12:00:00.000Z";
    await stub.ingestMessage({
      conversationRef: "conv_atomic_test",
      providerAccountRef: "123456789",
      providerParticipantRef: "573001112233",
      messageRef: "wamid.inbound.atomic",
      direction: "inbound",
      kind: "text",
      text: "Hello",
      occurredAt: inboundAt,
      status: "received"
    });
    const fingerprint = await sha256Base64Url("atomic-request");
    const reservation = {
      conversationRef: "conv_atomic_test",
      kind: "free_form_reply" as const,
      idempotencyKey: "reply:atomic:1",
      requestFingerprint: fingerprint,
      expectedPolicyRevision: "v1",
      now: "2026-09-07T12:01:00.000Z",
      notAfter: "2026-09-08T12:00:00.000Z"
    };
    await expect(stub.reserveOutboundDispatch(reservation)).resolves.toMatchObject({ status: "ready" });
    await stub.completeOutboundDispatch({
      idempotencyKey: reservation.idempotencyKey,
      requestFingerprint: fingerprint,
      conversationRef: reservation.conversationRef,
      providerAccountRef: "123456789",
      providerParticipantRef: "573001112233",
      messageRef: "wamid.outbound.atomic",
      providerStatus: "accepted",
      kind: "text",
      text: "Hi",
      occurredAt: "2026-09-07T12:01:01.000Z"
    });
    await expect(stub.reserveOutboundDispatch(reservation)).resolves.toMatchObject({
      status: "duplicate",
      messageRef: "wamid.outbound.atomic"
    });
    await expect(stub.reserveOutboundDispatch({
      ...reservation,
      requestFingerprint: await sha256Base64Url("different-request")
    })).resolves.toEqual({ status: "blocked", reason: "state_changed" });
    await expect(stub.reserveOutboundDispatch({
      ...reservation,
      idempotencyKey: "reply:atomic:late",
      requestFingerprint: await sha256Base64Url("late-request"),
      now: "2026-09-08T12:00:00.000Z"
    })).resolves.toEqual({ status: "blocked", reason: "window_closed" });
  });

  it("fails closed when an administrator targets an unknown conversation", async () => {
    const tenantId = `policy_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const response = await exports.default.fetch(new Request(
      `https://pilot.test/admin/pilot/tenants/${tenantId}/conversations/unknown_conversation/policy`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-pilot-admin-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ policyRevision: "v1", automationPaused: true })
      }
    ));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "PILOT_CONVERSATION_NOT_FOUND" }
    });
  });

  it("enforces the approved one-internal and three-client cohort ceilings", async () => {
    const registry = createPilotInstallationRegistry(
      env.PILOT_INSTALLATIONS,
      `cohort:test:${crypto.randomUUID()}`
    );
    const now = new Date("2026-09-07T12:00:00.000Z");
    const expiresAt = "2026-09-08T12:00:00.000Z";
    for (let index = 1; index <= 3; index += 1) {
      await expect(registry.createInvite({
        tenantId: `client_limit_${index}`,
        label: `Client ${index}`,
        cohortRole: "client",
        expiresAt
      }, now)).resolves.toMatch(/^[A-Za-z0-9_-]+$/u);
    }
    await expect(registry.createInvite({
      tenantId: "client_limit_4",
      label: "Client 4",
      cohortRole: "client",
      expiresAt
    }, now)).rejects.toThrow("Pilot client cohort limit reached");

    await expect(registry.createInvite({
      tenantId: "internal_limit_1",
      label: "Internal proof",
      cohortRole: "internal",
      expiresAt
    }, now)).resolves.toMatch(/^[A-Za-z0-9_-]+$/u);
    await expect(registry.createInvite({
      tenantId: "internal_limit_2",
      label: "Another internal proof",
      cohortRole: "internal",
      expiresAt
    }, now)).rejects.toThrow("Pilot internal cohort limit reached");
  });

  it("rotates a pending invitation and invalidates the previous token", async () => {
    const registry = createPilotInstallationRegistry(
      env.PILOT_INSTALLATIONS,
      `cohort:rotation:${crypto.randomUUID()}`
    );
    const now = new Date("2026-09-07T12:00:00.000Z");
    const input = {
      tenantId: `rotation_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      label: "Rotated client invitation",
      cohortRole: "client" as const,
      expiresAt: "2026-09-08T12:00:00.000Z"
    };
    const original = await registry.createInvite(input, now);
    const replacement = await registry.rotateInvite(input, new Date("2026-09-07T12:05:00.000Z"));

    await expect(registry.getInvite(original, now)).resolves.toBeNull();
    await expect(registry.getInvite(replacement, now)).resolves.toMatchObject({ tenantId: input.tenantId });
    await expect(registry.createInvite(input, now)).rejects.toThrow("Pilot tenant already has a cohort seat");
  });
});
