import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPilotInstallationRegistry } from "../src/meta/pilotInstallationStore.js";

function fixture() {
  const tenantId = `profile_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const digits = crypto.randomUUID().replace(/\D/g, "").padEnd(16, "7").slice(0, 16);
  const installation = {
    tenantId, wabaId: `1${digits}`, phoneNumberId: `2${digits}`,
    encryptedAccessToken: { ciphertext: "private-encrypted-token", iv: "private-iv", version: 1 as const },
    connectedAt: "2026-10-25T12:00:00.000Z", webhookSubscribedAt: "2026-10-25T12:00:00.000Z",
    status: "connected" as const
  };
  const stub = env.PILOT_INSTALLATIONS.getByName(`tenant:${tenantId}`);
  const url = `https://pilot.test/admin/pilot/installations/${tenantId}/account-profile`;
  const request = (method = "GET", body?: unknown, authorized = true) => new Request(url, {
    method, headers: {
      ...(authorized ? { Authorization: "Bearer test-pilot-admin-token" } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  const evidence = { source: "owner" as const, ref: "test-profile-receipt", observedAt: "2026-10-25T12:00:00.000Z" };
  const profile = {
    model: "morning-managed" as const,
    phoneOwner: { value: "morning" as const, evidence },
    messagingAccountOwner: { value: "morning" as const, evidence },
    metaPayer: { value: "unverified" as const },
    funding: { value: "provider-unavailable" as const, evidence: { ...evidence, source: "provider" as const } }
  };
  const command = { expectedRevision: 0, intentKey: "test-profile-original-key", profile };
  return { tenantId, stub, installation, request, command, evidence };
}

describe("operator-only pilot account profiles", () => {
  it("requires admin access and an installation; legacy installations remain connected without a profile", async () => {
    const f = fixture();
    expect((await exports.default.fetch(f.request("GET", undefined, false))).status).toBe(401);
    expect((await exports.default.fetch(f.request("PUT", f.command, false))).status).toBe(401);
    expect((await exports.default.fetch(f.request())).status).toBe(404);
    expect((await exports.default.fetch(f.request("PUT", f.command))).status).toBe(404);
    await f.stub.putInstallation(f.installation);
    const response = await exports.default.fetch(f.request());
    expect(await response.json()).toEqual({ ok: true, profile: null, revision: 0, reviewState: "not-recorded" });
    expect(await f.stub.getInstallation()).toEqual(f.installation);
    expect((await exports.default.fetch(f.request("POST", f.command))).status).toBe(405);
  });

  it("records evidence with atomic original-key recovery, stale-write protection and no provider mutation", async () => {
    const f = fixture();
    await f.stub.putInstallation(f.installation);
    const write = () => exports.default.fetch(f.request("PUT", f.command));
    expect(await (await write()).json()).toEqual({ ok: true, revision: 1, replayed: false });
    expect(await (await write()).json()).toEqual({ ok: true, revision: 1, replayed: true });
    const read = await exports.default.fetch(f.request());
    const body = await read.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      revision: 1, assetsMatch: true, evidenceBasis: "operator-recorded",
      reviewState: "needs-evidence", missingEvidence: ["metaPayer", "funding"], billingCollection: "not-configured"
    });
    expect(JSON.stringify(body)).not.toMatch(/private-encrypted|private-iv|wabaId|phoneNumberId/);
    expect(JSON.stringify(body)).not.toContain(f.installation.wabaId);
    expect(JSON.stringify(body)).not.toContain(f.installation.phoneNumberId);
    const changed = { ...f.command, profile: { ...f.command.profile, model: "client-direct" } };
    expect((await exports.default.fetch(f.request("PUT", changed))).status).toBe(409);
    expect((await exports.default.fetch(f.request("PUT", { ...changed, intentKey: "new-key-stale-revision" }))).status).toBe(409);
    const next = { ...changed, expectedRevision: 1, intentKey: "next-original-intent" };
    expect((await exports.default.fetch(f.request("PUT", next))).status).toBe(200);
    // An old recovered receipt must not replace a newer profile.
    expect(await (await write()).json()).toEqual({ ok: true, revision: 1, replayed: true });
    expect(await (await exports.default.fetch(f.request())).json()).toMatchObject({
      revision: 2, reviewState: "model-mismatch", modelMismatch: ["phoneOwner", "messagingAccountOwner"]
    });
    expect(await f.stub.getInstallation()).toEqual(f.installation);
    expect(await f.stub.getWabaRoute()).toBeNull();
  });

  it("separates tenants, survives credential refresh, and invalidates evidence after asset changes or disconnect", async () => {
    const f = fixture();
    const other = fixture();
    await f.stub.putInstallation(f.installation);
    await other.stub.putInstallation(other.installation);
    await exports.default.fetch(f.request("PUT", f.command));
    expect(await (await exports.default.fetch(other.request())).json()).toMatchObject({ profile: null, revision: 0 });
    await f.stub.putInstallation({ ...f.installation, encryptedAccessToken: { ...f.installation.encryptedAccessToken, ciphertext: "refreshed" } });
    expect(await (await exports.default.fetch(f.request())).json()).toMatchObject({ revision: 1, assetsMatch: true });
    await f.stub.putInstallation({ ...f.installation, phoneNumberId: "999123456789" });
    expect(await (await exports.default.fetch(f.request())).json()).toMatchObject({
      revision: 1, assetsMatch: false, reviewState: "needs-reverification"
    });
    await f.stub.putInstallation(f.installation);
    await f.stub.markInstallationDisconnected("2026-10-25T12:05:00.000Z");
    expect(await (await exports.default.fetch(f.request())).json()).toMatchObject({ reviewState: "needs-reverification" });
    await f.stub.deleteInstallation();
    expect(await f.stub.getAccountProfile()).toBeNull();
    await f.stub.putInstallation(f.installation);
    expect(await (await exports.default.fetch(f.request("PUT", f.command))).json()).toMatchObject({ revision: 1, replayed: false });
  });

  it("rejects extra fields and future evidence and serializes competing revisions", async () => {
    const f = fixture();
    await f.stub.putInstallation(f.installation);
    const invalid = [
      { ...f.command, accessToken: "never-store" },
      { ...f.command, profile: { ...f.command.profile, tenantId: "other-tenant" } },
      { ...f.command, profile: { ...f.command.profile, funding: { value: "recorded" } } },
      { ...f.command, profile: { ...f.command.profile, phoneOwner: { value: "morning", evidence: { ...f.evidence, observedAt: "2099-01-01T00:00:00.000Z" } } } },
      { ...f.command, profile: { ...f.command.profile, phoneOwner: { value: "morning", evidence: { ...f.evidence, ref: "https://example.test/?token=secret" } } } }
    ];
    for (const command of invalid) expect((await exports.default.fetch(f.request("PUT", command))).status).toBe(400);
    expect(await f.stub.getAccountProfile()).toBeNull();
    const concurrent = await Promise.all([f.command, { ...f.command, intentKey: "competing-original-key" }]
      .map(command => exports.default.fetch(f.request("PUT", command))));
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await f.stub.getAccountProfile())?.revision).toBe(1);
  });

  it("keeps a fully evidenced client-direct account distinct from billing collection", async () => {
    const f = fixture();
    await f.stub.putInstallation(f.installation);
    const client = { value: "client" as const, evidence: f.evidence };
    const profile = {
      model: "client-direct" as const, phoneOwner: client, messagingAccountOwner: client, metaPayer: client,
      funding: { value: "recorded" as const, evidence: f.evidence }
    };
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    await registry.putAccountProfile(f.tenantId, { ...f.command, profile }, new Date("2026-10-25T12:01:00.000Z"));
    expect(await registry.getAccountProfile(f.tenantId)).toMatchObject({
      revision: 1, reviewState: "evidence-recorded", billingCollection: "not-configured", missingEvidence: [], modelMismatch: []
    });
  });
});
