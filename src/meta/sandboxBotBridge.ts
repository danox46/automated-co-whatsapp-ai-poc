import type { DurableConversationNamespace } from "../mcp/durableConversationStore.js";
import type { WhatsAppMessagingCapability } from "../mcp/outboundPolicy.js";
import { dispatchFreeFormReply } from "../mcp/outboundPolicy.js";
import { secureEqualText } from "./pilotCrypto.js";
import type { WhatsAppSandboxConfig } from "./sandboxConfig.js";

const base = "/bot/sandbox";
const conversationRefPattern = /^conv_[A-Za-z0-9_-]{32}$/u;

/** A single-tenant service bridge for the parallel, app-owned test-number bot. */
export function createSandboxBotBridge(input: {
  token?: string;
  sandbox: WhatsAppSandboxConfig | null;
  conversations: DurableConversationNamespace;
  messaging?: WhatsAppMessagingCapability;
  listFlows?: () => Promise<Array<{ id: string; name: string; status: string }>>;
  resource: string;
}) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== `${base}/flows` && url.pathname !== `${base}/conversations` && !url.pathname.startsWith(`${base}/conversations/`)) return null;
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (!input.token || !input.sandbox || !input.messaging) {
      return Response.json({ ok: false, code: "SANDBOX_BRIDGE_UNAVAILABLE" }, { status: 503, headers });
    }
    const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
    if (!match || !await secureEqualText(match[1], input.token)) {
      return Response.json({ ok: false, code: "SANDBOX_BRIDGE_AUTH_REQUIRED" }, { status: 401, headers });
    }
    if (url.pathname === `${base}/flows` && request.method === "GET") {
      if (!input.listFlows) return Response.json({ ok: false, code: "FLOW_LOOKUP_UNAVAILABLE" }, { status: 503, headers });
      try { return Response.json({ ok: true, flows: await input.listFlows() }, { headers }); }
      catch { return Response.json({ ok: false, code: "META_FLOW_LOOKUP_FAILED" }, { status: 502, headers }); }
    }
    const stub = input.conversations.getByName(input.sandbox.tenantId);
    await stub.initializeTenant(input.sandbox.tenantId);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (cursor && (cursor.length > 512 || !/^[A-Za-z0-9_=-]+$/u.test(cursor))) {
      return Response.json({ ok: false, code: "INVALID_CURSOR" }, { status: 400, headers });
    }
    if (url.pathname === `${base}/conversations` && request.method === "GET") {
      const result = await stub.listConversations({ limit: 50, ...(cursor ? { cursor } : {}) });
      return Response.json({ ok: true, ...result }, { headers });
    }
    const route = /^\/bot\/sandbox\/conversations\/(conv_[A-Za-z0-9_-]{32})\/(history|replies)$/u.exec(url.pathname);
    if (!route || !conversationRefPattern.test(route[1])) {
      return Response.json({ ok: false, code: "SANDBOX_BRIDGE_ROUTE_INVALID" }, { status: 404, headers });
    }
    if (route[2] === "history" && request.method === "GET") {
      const result = await stub.getConversationHistory({ conversationRef: route[1], limit: 100, ...(cursor ? { cursor } : {}) });
      return Response.json(result ? { ok: true, ...result } : { ok: false, code: "CONVERSATION_NOT_FOUND" },
        { status: result ? 200 : 404, headers });
    }
    if (route[2] === "replies" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return Response.json({ ok: false, code: "INVALID_CONTENT_TYPE" }, { status: 415, headers });
      }
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 8192) return Response.json({ ok: false, code: "MESSAGE_TOO_LARGE" }, { status: 413, headers });
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; }
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "idempotencyKey,text") {
        return Response.json({ ok: false, code: "INVALID_REPLY" }, { status: 400, headers });
      }
      const { text, idempotencyKey } = body as Record<string, unknown>;
      if (typeof text !== "string" || text.length < 1 || text.length > 4096 ||
          typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(idempotencyKey)) {
        return Response.json({ ok: false, code: "INVALID_REPLY" }, { status: 400, headers });
      }
      try {
        const result = await dispatchFreeFormReply(input.messaging, {
          subject: "sandbox-bot-bridge",
          tenantId: input.sandbox.tenantId,
          audience: input.resource,
          scopes: new Set(["whatsapp.messages.send"])
        }, { conversationRef: route[1], text, idempotencyKey });
        return Response.json(result, { status: result.ok ? 200 : 409, headers });
      } catch {
        return Response.json({ ok: false, code: "SANDBOX_PROVIDER_OUTCOME_UNKNOWN" }, { status: 502, headers });
      }
    }
    return Response.json({ ok: false, code: "METHOD_NOT_ALLOWED" }, { status: 405, headers });
  };
}
