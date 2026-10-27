import { MetaGraphError, type createMetaGraphClient } from "./graphClient.js";
import { secureEqualText } from "./pilotCrypto.js";

type Graph = ReturnType<typeof createMetaGraphClient>;
const names = {
  visit: { name: "Sol Sandbox - Agendar visita", category: "APPOINTMENT_BOOKING", screen: "VISIT_SCHEDULE" },
  wholesale: { name: "Sol Sandbox - Perfil mayorista", category: "LEAD_GENERATION", screen: "WHOLESALE_PROFILE" }
} as const;

/** Narrow admin-only Flow creation for the app-owned test WABA. */
export function createSandboxFlowAdmin(input: {
  adminToken?: string;
  wabaId?: string;
  graph?: Graph;
  accessToken: () => Promise<string>;
}) {
  return async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (path !== "/admin/pilot/sandbox/flows" && !/^\/admin\/pilot\/sandbox\/flows\/\d{3,32}\/publish$/u.test(path)) return null;
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (!input.adminToken || !input.wabaId || !input.graph) return Response.json({ ok: false, code: "FLOW_ADMIN_UNAVAILABLE" }, { status: 503, headers });
    const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
    if (!match || !await secureEqualText(match[1], input.adminToken)) {
      return Response.json({ ok: false, code: "FLOW_ADMIN_AUTH_REQUIRED" }, { status: 401, headers });
    }
    if (request.method !== "POST") return Response.json({ ok: false, code: "METHOD_NOT_ALLOWED" }, { status: 405, headers });
    try {
      const token = await input.accessToken();
      if (path.endsWith("/publish")) {
        const id = path.split("/")[5];
        const flow = (await input.graph.listFlows(token, input.wabaId)).find(f => f.id === id);
        if (!flow || !Object.values(names).some(n => n.name === flow.name) || flow.status !== "DRAFT") {
          return Response.json({ ok: false, code: "SANDBOX_DRAFT_NOT_FOUND" }, { status: 404, headers });
        }
        await input.graph.publishFlow(token, id);
        return Response.json({ ok: true, id, status: "PUBLISHED" }, { headers });
      }
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return Response.json({ ok: false, code: "INVALID_CONTENT_TYPE" }, { status: 415, headers });
      }
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 32_768) return Response.json({ ok: false, code: "FLOW_TOO_LARGE" }, { status: 413, headers });
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; }
      if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ ok: false, code: "INVALID_FLOW" }, { status: 400, headers });
      const { type, flowJson } = body as Record<string, unknown>;
      if ((type !== "visit" && type !== "wholesale") || typeof flowJson !== "string") {
        return Response.json({ ok: false, code: "INVALID_FLOW" }, { status: 400, headers });
      }
      const definition = names[type];
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(flowJson) as Record<string, unknown>; } catch {
        return Response.json({ ok: false, code: "INVALID_FLOW_JSON" }, { status: 400, headers });
      }
      const screens = parsed.screens;
      if (!Array.isArray(screens) || screens.length !== 1 || screens[0]?.id !== definition.screen ||
          screens[0]?.terminal !== true || screens[0]?.success !== true) {
        return Response.json({ ok: false, code: "FLOW_SCHEMA_MISMATCH" }, { status: 400, headers });
      }
      const existing = (await input.graph.listFlows(token, input.wabaId)).find(f => f.name === definition.name);
      if (existing?.status === "PUBLISHED") return Response.json({ ok: true, id: existing.id, status: existing.status, existed: true }, { headers });
      const id = existing?.status === "DRAFT" ? existing.id :
        await input.graph.createFlow(token, input.wabaId, definition.name, definition.category);
      try {
        const validationErrors = await input.graph.uploadFlowJson(token, id, flowJson);
        return Response.json({ ok: validationErrors.length === 0, id, status: "DRAFT", validationErrors },
          { status: validationErrors.length ? 422 : 200, headers });
      } catch (error) {
        return Response.json({ ok: false, id, status: "DRAFT", code: error instanceof MetaGraphError ? error.code : "META_FLOW_UPLOAD_FAILED" },
          { status: 502, headers });
      }
    } catch (error) {
      return Response.json({ ok: false, code: error instanceof MetaGraphError ? error.code : "FLOW_ADMIN_FAILED" },
        { status: 502, headers });
    }
  };
}
