import { describe, expect, it, vi } from "vitest";
import { createSandboxFlowAdmin } from "./sandboxFlowAdmin.js";
import type { createMetaGraphClient } from "./graphClient.js";

const origin = "https://mcp.example.test";
const definition = JSON.stringify({ version: "7.3", screens: [{ id: "VISIT_SCHEDULE", terminal: true, success: true }] });

function setup() {
  const listFlows = vi.fn(async () => [] as Array<{ id: string; name: string; status: string }>);
  const createFlow = vi.fn(async () => "123456");
  const uploadFlowJson = vi.fn(async () => [] as Array<{ code: string }>);
  const publishFlow = vi.fn(async () => undefined);
  const graph = { listFlows, createFlow, uploadFlowJson, publishFlow } as unknown as ReturnType<typeof createMetaGraphClient>;
  const accessToken = vi.fn(async () => "hidden-meta-token");
  const handler = createSandboxFlowAdmin({ adminToken: "admin-token", wabaId: "934775242587261", graph, accessToken });
  return { handler, listFlows, createFlow, uploadFlowJson, publishFlow, accessToken };
}

function request(path: string, token: string, body?: unknown) {
  return new Request(`${origin}${path}`, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {})
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

describe("sandbox Flow administration", () => {
  it("rejects unauthorized requests before reading the Meta installation", async () => {
    const f = setup();
    expect((await f.handler(request("/admin/pilot/sandbox/flows", "wrong", { type: "visit", flowJson: definition })))?.status).toBe(401);
    expect(f.accessToken).not.toHaveBeenCalled();
  });

  it("only creates the named visit draft with its matching first screen", async () => {
    const f = setup();
    const wrong = await f.handler(request("/admin/pilot/sandbox/flows", "admin-token", {
      type: "wholesale", flowJson: definition
    }));
    expect(wrong?.status).toBe(400);
    expect(f.createFlow).not.toHaveBeenCalled();
    const result = await f.handler(request("/admin/pilot/sandbox/flows", "admin-token", {
      type: "visit", flowJson: definition
    }));
    expect(await result?.json()).toEqual({ ok: true, id: "123456", status: "DRAFT", validationErrors: [] });
    expect(f.createFlow).toHaveBeenCalledWith("hidden-meta-token", "934775242587261",
      "Sol Sandbox - Agendar visita", "APPOINTMENT_BOOKING");
    expect(f.uploadFlowJson).toHaveBeenCalledWith("hidden-meta-token", "123456", definition);
  });

  it("publishes only a draft with the exact sandbox name", async () => {
    const f = setup();
    f.listFlows.mockResolvedValueOnce([{ id: "123456", name: "Client production visit", status: "DRAFT" }]);
    expect((await f.handler(request("/admin/pilot/sandbox/flows/123456/publish", "admin-token")))?.status).toBe(404);
    expect(f.publishFlow).not.toHaveBeenCalled();
    f.listFlows.mockResolvedValueOnce([{ id: "123456", name: "Sol Sandbox - Agendar visita", status: "DRAFT" }]);
    expect((await f.handler(request("/admin/pilot/sandbox/flows/123456/publish", "admin-token")))?.status).toBe(200);
    expect(f.publishFlow).toHaveBeenCalledWith("hidden-meta-token", "123456");
  });
});
