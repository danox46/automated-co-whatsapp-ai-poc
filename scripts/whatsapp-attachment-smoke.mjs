#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const [baseUrl, tenantId, conversationRef, attachmentRef, outputPath] = process.argv.slice(2);
const adminToken = process.env.PILOT_ADMIN_TOKEN;
if (!adminToken || !baseUrl || !tenantId || !conversationRef || !attachmentRef || !outputPath) {
  throw new Error("Usage: attachment-smoke <https-origin> <tenant-id> <conversation-ref> <attachment-ref> <output-path>");
}

const origin = new URL(baseUrl).origin;
const clientId = "https://chatgpt.com/oauth/client.json";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const refreshResponse = await fetch(
  `${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}/refresh-sandbox-credential`,
  { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } },
);
if (!refreshResponse.ok) throw new Error("Sandbox credential refresh failed.");
const setCookie = refreshResponse.headers.get("set-cookie");
const sessionCookie = setCookie?.split(";", 1)[0];
if (!sessionCookie?.startsWith("__Host-wa_pilot_session=")) throw new Error("OAuth session cookie was not returned.");

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
const state = randomBytes(32).toString("base64url");
const authorizeUrl = new URL(`${origin}/oauth/authorize`);
authorizeUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  resource: origin,
  scope: "openid whatsapp.media.read",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();
const authorizeResponse = await fetch(authorizeUrl, {
  headers: { Cookie: sessionCookie },
  redirect: "manual",
});
const redirect = new URL(authorizeResponse.headers.get("location") ?? "", redirectUri);
if (authorizeResponse.status !== 302 || redirect.searchParams.get("state") !== state) {
  throw new Error("OAuth authorization failed.");
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
if (!tokenResponse.ok) throw new Error("OAuth token exchange failed.");
const token = await tokenResponse.json();
if (!token?.access_token || !token?.refresh_token) throw new Error("OAuth token response was incomplete.");

const client = new Client({ name: "morning-arp-whatsapp-attachment-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "whatsapp_get_attachment")) {
    throw new Error("whatsapp_get_attachment is unavailable.");
  }
  const result = await client.callTool({
    name: "whatsapp_get_attachment",
    arguments: { conversationRef, attachmentRef },
  });
  if (result.isError) throw new Error("whatsapp_get_attachment returned an error.");
  const image = result.content?.find((item) => item.type === "image");
  if (!image?.data || image.mimeType !== "image/jpeg") throw new Error("Native MCP JPEG content was not returned.");
  const bytes = Buffer.from(image.data, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("base64");
  const structured = result.structuredContent?.attachment;
  if (!structured || structured.sha256 !== sha256 || structured.sizeBytes !== bytes.byteLength) {
    throw new Error("MCP attachment metadata does not match the returned bytes.");
  }
  await writeFile(outputPath, bytes, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    attachmentRef,
    mimeType: image.mimeType,
    sizeBytes: bytes.byteLength,
    sha256,
    outputPath,
    oauthTokensRevoked: true,
  }, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
  await revoke(token.access_token);
  await revoke(token.refresh_token);
}

async function revoke(value) {
  if (!value) return;
  await fetch(`${origin}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: value }),
  });
}
