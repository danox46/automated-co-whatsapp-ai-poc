export type MetaWebhookEnv = {
  META_WEBHOOK_VERIFY_TOKEN: string;
  META_APP_SECRET: string;
};

export const META_WHATSAPP_WEBHOOK_PATH = "/webhooks/meta/whatsapp";
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const encoder = new TextEncoder();

function noStoreHeaders(contentType = "text/plain; charset=utf-8"): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff"
  };
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function constantTimeEqualText(left: string, right: string): Promise<boolean> {
  return constantTimeEqual(await sha256(left), await sha256(right));
}

function parseSha256Signature(header: string | null): Uint8Array | null {
  if (!header?.startsWith("sha256=")) return null;
  const hex = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;

  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

async function verifyMetaSignature(
  body: ArrayBuffer,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  const suppliedSignature = parseSha256Signature(signatureHeader);
  if (!suppliedSignature || !appSecret) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedSignature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return constantTimeEqual(suppliedSignature, expectedSignature);
}

async function handleVerification(request: Request, env: MetaWebhookEnv): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode") ?? "";
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (
    mode !== "subscribe" ||
    !challenge ||
    !env.META_WEBHOOK_VERIFY_TOKEN ||
    !(await constantTimeEqualText(token, env.META_WEBHOOK_VERIFY_TOKEN))
  ) {
    return new Response("Forbidden", { status: 403, headers: noStoreHeaders() });
  }

  return new Response(challenge, { status: 200, headers: noStoreHeaders() });
}

async function handleEvent(
  request: Request,
  env: MetaWebhookEnv,
  persistence?: MetaConversationPersistence
): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload too large", { status: 413, headers: noStoreHeaders() });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload too large", { status: 413, headers: noStoreHeaders() });
  }

  const signatureValid = await verifyMetaSignature(
    body,
    request.headers.get("x-hub-signature-256"),
    env.META_APP_SECRET
  );
  if (!signatureValid) {
    return new Response("Unauthorized", { status: 401, headers: noStoreHeaders() });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: noStoreHeaders() });
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { object?: unknown }).object !== "whatsapp_business_account"
  ) {
    return new Response("Unsupported event", { status: 400, headers: noStoreHeaders() });
  }

  if (persistence) {
    try {
      await persistMetaConversationEvents(payload, persistence);
    } catch {
      return Response.json(
        { received: false, retryable: true },
        { status: 503, headers: noStoreHeaders("application/json; charset=utf-8") }
      );
    }
  }

  // Raw provider payloads are never retained or echoed. When persistence is
  // configured, only normalized bounded records are stored after signature and
  // envelope validation succeeds.
  return Response.json(
    { received: true },
    { status: 200, headers: noStoreHeaders("application/json; charset=utf-8") }
  );
}

export async function handleMetaWhatsAppWebhook(
  request: Request,
  env: MetaWebhookEnv,
  persistence?: MetaConversationPersistence
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== META_WHATSAPP_WEBHOOK_PATH) return null;

  if (request.method === "GET") return handleVerification(request, env);
  if (request.method === "POST") return handleEvent(request, env, persistence);

  return new Response("Method not allowed", {
    status: 405,
    headers: { ...noStoreHeaders(), Allow: "GET, POST" }
  });
}

export default {
  async fetch(request: Request, env: MetaWebhookEnv): Promise<Response> {
    const webhookResponse = await handleMetaWhatsAppWebhook(request, env);
    if (webhookResponse) return webhookResponse;

    if (new URL(request.url).pathname === "/health") {
      return Response.json({
        ok: true,
        environment: "sandbox",
        webhook: "signature-required",
        payloadRetention: false,
        outboundMessaging: false
      }, {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    return new Response("Not found", { status: 404, headers: noStoreHeaders() });
  }
};
import {
  persistMetaConversationEvents,
  type MetaConversationPersistence
} from "./conversationEvents.js";
