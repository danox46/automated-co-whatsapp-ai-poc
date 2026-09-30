#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const [baseUrl, tenantId, conversationRef, templateName = "hello_world", languageCode = "en_US", purpose = "sandbox_test"] = process.argv.slice(2);
const adminToken = process.env.PILOT_ADMIN_TOKEN;

if (!adminToken || !baseUrl || !tenantId || !conversationRef) {
  throw new Error("Usage: PILOT_ADMIN_TOKEN=<secret> node scripts/whatsapp-mcp-smoke.mjs <https-origin> <tenant-id> <conversation-ref> [template-name] [language-code] [purpose]");
}

const origin = new URL(baseUrl).origin;
const clientId = "https://chatgpt.com/oauth/client.json";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const scopes = [
  "openid",
  "whatsapp.policy.read",
  "whatsapp.connection.read",
  "whatsapp.conversations.read",
  "whatsapp.messages.send",
];
const adminHeaders = { Authorization: `Bearer ${adminToken}` };

const templateResponse = await adminFetch(
  `/admin/pilot/tenants/${encodeURIComponent(tenantId)}/templates/${encodeURIComponent(templateName)}`,
  {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ languageCode, purpose, enabled: true }),
  },
);
const template = templateResponse.template;
if (!template?.category) throw new Error("Meta did not return the approved template category.");

await adminFetch(
  `/admin/pilot/tenants/${encodeURIComponent(tenantId)}/conversations/${encodeURIComponent(conversationRef)}/template-consent`,
  {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      categories: [template.category],
      purposes: [purpose],
      policyRevision: "sandbox-smoke-v1",
    }),
  },
);

const refreshResponse = await fetch(
  `${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}/refresh-sandbox-credential`,
  { method: "POST", headers: adminHeaders },
);
if (!refreshResponse.ok) throw new Error(await safeError(refreshResponse, "Sandbox credential refresh failed."));
const refresh = await refreshResponse.json();
if (!refresh?.oauthReady) throw new Error("Sandbox OAuth session was not prepared.");
const setCookie = refreshResponse.headers.get("set-cookie");
const sessionCookie = setCookie?.split(";", 1)[0];
if (!sessionCookie?.startsWith("__Host-wa_pilot_session=")) {
  throw new Error("Sandbox OAuth session cookie was not returned.");
}

const verifier = base64Url(randomBytes(48));
const challenge = base64Url(createHash("sha256").update(verifier, "ascii").digest());
const state = base64Url(randomBytes(32));
const authorizeUrl = new URL(`${origin}/oauth/authorize`);
authorizeUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  resource: origin,
  scope: scopes.join(" "),
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

const authorizeResponse = await fetch(authorizeUrl, {
  headers: { Cookie: sessionCookie },
  redirect: "manual",
});
if (authorizeResponse.status !== 302) {
  throw new Error(await safeError(authorizeResponse, "OAuth authorization failed."));
}
const redirect = new URL(authorizeResponse.headers.get("location") ?? "", redirectUri);
if (redirect.origin !== "https://chatgpt.com" || redirect.pathname !== "/connector_platform_oauth_redirect" ||
    redirect.searchParams.get("state") !== state) {
  throw new Error("OAuth redirect binding failed.");
}
const code = redirect.searchParams.get("code");
if (!code) throw new Error("OAuth authorization code was not returned.");

const tokenResponse = await fetch(`${origin}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: origin,
    code_verifier: verifier,
  }),
});
if (!tokenResponse.ok) throw new Error(await safeError(tokenResponse, "OAuth token exchange failed."));
const token = await tokenResponse.json();
if (!token?.access_token || !token?.refresh_token) throw new Error("OAuth token response was incomplete.");

const client = new Client({ name: "morning-arp-whatsapp-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
});

let reply;
let templateSend;
const runId = new Date().toISOString().replace(/[-:.TZ]/gu, "");
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of ["whatsapp_reply_to_inbound", "whatsapp_send_template"]) {
    if (!names.has(required)) throw new Error(`Required MCP tool is unavailable: ${required}`);
  }
  reply = await client.callTool({
    name: "whatsapp_reply_to_inbound",
    arguments: {
      conversationRef,
      text: "Morning ARP MCP test: free-form reply received successfully.",
      idempotencyKey: `sandbox-freeform-${runId}`,
    },
  });
  if (reply.isError) throw new Error(`Free-form MCP send failed: ${toolMessage(reply)}`);

  templateSend = await client.callTool({
    name: "whatsapp_send_template",
    arguments: {
      conversationRef,
      templateName,
      variables: [],
      idempotencyKey: `sandbox-template-${runId}`,
    },
  });
  if (templateSend.isError) throw new Error(`Template MCP send failed: ${toolMessage(templateSend)}`);
} finally {
  await client.close().catch(() => undefined);
  await revoke(token.access_token);
  await revoke(token.refresh_token);
}

const history = await adminFetch(
  `/admin/pilot/tenants/${encodeURIComponent(tenantId)}/conversations/${encodeURIComponent(conversationRef)}/history?limit=25`,
  { method: "GET" },
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  tenantId,
  template: { name: template.name, category: template.category, languageCode: template.languageCode, purpose },
  freeForm: receipt(reply),
  templateSend: receipt(templateSend),
  historyMessages: Array.isArray(history.messages) ? history.messages.length : null,
  providerStatus: refresh.providerSubscription,
  oauthTokensRevoked: true,
}, null, 2)}\n`);

async function adminFetch(path, init) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...adminHeaders, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(await safeError(response, `Admin request failed (${response.status}).`));
  return response.json();
}

async function safeError(response, fallback) {
  const payload = await response.json().catch(() => null);
  return payload?.error?.code ? `${payload.error.code}: ${payload.error.message ?? fallback}` : fallback;
}

function base64Url(value) {
  return value.toString("base64url");
}

function toolMessage(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) return "No structured error was returned.";
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.code ? `${parsed.error.code}: ${parsed.error.message ?? "Unknown error"}` : "Unknown tool error";
  } catch {
    return "Unreadable tool error";
  }
}

function receipt(result) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object") {
    return {
      ok: structured.ok === true,
      messageRef: typeof structured.messageRef === "string" ? structured.messageRef : undefined,
      status: typeof structured.status === "string" ? structured.status : undefined,
    };
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  try {
    const parsed = text ? JSON.parse(text) : null;
    return {
      ok: parsed?.ok === true,
      messageRef: typeof parsed?.messageRef === "string" ? parsed.messageRef : undefined,
      status: typeof parsed?.status === "string" ? parsed.status : undefined,
    };
  } catch {
    return { ok: false };
  }
}

async function revoke(value) {
  if (!value) return;
  await fetch(`${origin}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: value }),
  });
}
