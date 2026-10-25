import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const origin = "https://pilot.test";
const ref = `conv_${"a".repeat(32)}`;
const tenantId = "worker-test-sandbox";
const headers = { Authorization: "Bearer synthetic-worker-test-bridge-token" };

// Exercise the configured Worker export, not just createSandboxBotBridge().
// No provider requests or real credentials are used in this suite.
describe("deployed-entry sandbox bridge contract", () => {
  it("advertises the configured bridge through the actual health route", async () => {
    const response = await exports.default.fetch(new Request(`${origin}/health`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sandboxConfigured: true,
      sandboxConfigurationValid: true,
      sandboxBotBridgeConfigured: true,
      draftFlowTestingConfigured: true,
      sandboxRecipientRestriction: "server-allowlist"
    });
  });

  for (const [method, path] of [
    ["GET", "/bot/sandbox/conversations"],
    ["GET", `/bot/sandbox/conversations/${ref}/history`],
    ["POST", `/bot/sandbox/conversations/${ref}/replies`],
    ["POST", `/bot/sandbox/conversations/${ref}/flows`],
    ["GET", "/bot/sandbox/flows"]
  ]) {
    it(`keeps ${method} ${path} wired and protected before any operation`, async () => {
      for (const authorization of [undefined, "Bearer wrong-test-token"]) {
        const response = await exports.default.fetch(new Request(`${origin}${path}`, {
          method, headers: authorization ? { Authorization: authorization } : {}
        }));
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toEqual({ ok: false, code: "SANDBOX_BRIDGE_AUTH_REQUIRED" });
      }
    });
  }

  it("reads only the fixed sandbox tenant through the Worker export", async () => {
    const sandbox = env.CONVERSATIONS.getByName(tenantId);
    const other = env.CONVERSATIONS.getByName("other-worker-test-tenant");
    const now = new Date().toISOString();
    for (const [stub, id, text] of [
      [sandbox, tenantId, "synthetic sandbox fixture"],
      [other, "other-worker-test-tenant", "other tenant fixture must stay private"]
    ] as const) {
      await stub.initializeTenant(id);
      await stub.ingestMessage({
        conversationRef: ref, providerAccountRef: "15550000002",
        providerParticipantRef: "15550000001", messageRef: `fixture-${id}`,
        direction: "inbound", kind: "text", text, occurredAt: now, status: "received"
      });
    }
    const list = await exports.default.fetch(new Request(`${origin}/bot/sandbox/conversations`, { headers }));
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(ref);
    const history = await exports.default.fetch(new Request(`${origin}/bot/sandbox/conversations/${ref}/history`, { headers }));
    expect(history.status).toBe(200);
    const body = await history.text();
    expect(body).toContain("synthetic sandbox fixture");
    expect(body).not.toContain("other tenant fixture");
    expect(body).not.toContain("15550000001");
    expect(body).not.toContain("synthetic-worker-test-access-token");
  });
});
