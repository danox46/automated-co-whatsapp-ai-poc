#!/usr/bin/env node

class PilotAdminError extends Error {}

try {
const [command, baseUrl, ...argumentsAfterOrigin] = process.argv.slice(2);
const adminToken = process.env.PILOT_ADMIN_TOKEN;

if (!adminToken || !command || !baseUrl) {
  fail("Usage: PILOT_ADMIN_TOKEN=<secret> npm run pilot:admin -- <sandbox-invite|sandbox-reinvite|sandbox-connect|refresh-sandbox-credential|flow-draft|flow-publish|invite|reinvite|status|provider-status|conversations|history|capture-attachment|disconnect|reconcile-disconnect|delete> <https-origin> [arguments]");
}

const origin = new URL(baseUrl).origin;
const headers = { Authorization: `Bearer ${adminToken}` };
let response;

if (command === "sandbox-connect") {
  const label = argumentsAfterOrigin[0];
  if (!label) fail("sandbox-connect requires a human-readable owner label.");
  const inviteResponse = await fetch(`${origin}/admin/pilot/sandbox/invitations`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ label, expiresInHours: 24 })
  });
  const invitation = await inviteResponse.json().catch(() => null);
  if (!inviteResponse.ok || !invitation?.invitationUrl || !invitation?.tenantId) {
    fail(invitation?.error?.code
      ? `${invitation.error.code}: ${invitation.error.message ?? "Sandbox invitation failed."}`
      : `Sandbox invitation failed (HTTP ${inviteResponse.status}).`);
  }

  const claimResponse = await fetch(invitation.invitationUrl, { redirect: "manual" });
  const setCookie = claimResponse.headers.get("set-cookie");
  const location = claimResponse.headers.get("location");
  if (claimResponse.status !== 303 || !setCookie || !location) {
    fail(`Sandbox invitation claim failed (HTTP ${claimResponse.status}).`);
  }

  const connectResponse = await fetch(new URL(location, origin), {
    redirect: "manual",
    headers: { Cookie: setCookie.split(";", 1)[0] }
  });
  await connectResponse.arrayBuffer();
  if (!connectResponse.ok) {
    fail(`Sandbox connection failed (HTTP ${connectResponse.status}).`);
  }

  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(invitation.tenantId)}`, { headers });
} else if (command === "sandbox-invite" || command === "sandbox-reinvite") {
  const label = argumentsAfterOrigin[0];
  if (!label) fail(`The ${command} command requires a human-readable owner label.`);
  const sandboxInvitationPath = command === "sandbox-reinvite"
    ? "/admin/pilot/sandbox/invitations/rotate"
    : "/admin/pilot/sandbox/invitations";
  response = await fetch(`${origin}${sandboxInvitationPath}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ label, expiresInHours: 24 })
  });
} else if (command === "invite" || command === "reinvite") {
  const [tenantId, ...rest] = argumentsAfterOrigin;
  if (!tenantId) fail(`${command} requires a tenant ID.`);
  const label = rest[0];
  const cohortRole = rest[1] ?? "client";
  if (!label) fail("The invite command requires a human-readable pilot label.");
  const invitationPath = command === "reinvite"
    ? "/admin/pilot/invitations/rotate"
    : "/admin/pilot/invitations";
  response = await fetch(`${origin}${invitationPath}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, label, cohortRole, expiresInHours: 24 })
  });
} else if (command === "status") {
  const tenantId = argumentsAfterOrigin[0];
  if (!tenantId) fail("status requires a tenant ID.");
  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}`, { headers });
} else if (command === "provider-status") {
  const tenantId = argumentsAfterOrigin[0];
  if (!tenantId) fail("provider-status requires a tenant ID.");
  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}/provider-status`, { headers });
} else if (command === "refresh-sandbox-credential") {
  const tenantId = argumentsAfterOrigin[0];
  if (!tenantId) fail("refresh-sandbox-credential requires a tenant ID.");
  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}/refresh-sandbox-credential`, {
    method: "POST",
    headers
  });
} else if (command === "flow-draft") {
  const [type, path] = argumentsAfterOrigin;
  if (!(["visit", "wholesale"].includes(type)) || !path) fail("flow-draft requires visit|wholesale and a local JSON file path.");
  const { readFile } = await import("node:fs/promises");
  const flowJson = await readFile(path, "utf8");
  response = await fetch(`${origin}/admin/pilot/sandbox/flows`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ type, flowJson })
  });
} else if (command === "flow-publish") {
  const id = argumentsAfterOrigin[0];
  if (!/^\d{3,32}$/.test(id ?? "")) fail("flow-publish requires a numeric Flow ID.");
  response = await fetch(`${origin}/admin/pilot/sandbox/flows/${id}/publish`, { method: "POST", headers });
} else if (command === "conversations") {
  const tenantId = argumentsAfterOrigin[0];
  if (!tenantId) fail("conversations requires a tenant ID.");
  response = await fetch(`${origin}/admin/pilot/tenants/${encodeURIComponent(tenantId)}/conversations`, { headers });
} else if (command === "history") {
  const [tenantId, conversationRef] = argumentsAfterOrigin;
  if (!tenantId || !conversationRef) fail("history requires a tenant ID and conversation reference.");
  response = await fetch(`${origin}/admin/pilot/tenants/${encodeURIComponent(tenantId)}/conversations/${encodeURIComponent(conversationRef)}/history`, { headers });
} else if (command === "capture-attachment") {
  const [tenantId, conversationRef, attachmentRef] = argumentsAfterOrigin;
  if (!tenantId || !conversationRef || !attachmentRef) {
    fail("capture-attachment requires a tenant ID, conversation reference, and attachment reference.");
  }
  response = await fetch(`${origin}/admin/pilot/tenants/${encodeURIComponent(tenantId)}/conversations/${encodeURIComponent(conversationRef)}/attachments/${encodeURIComponent(attachmentRef)}/capture`, {
    method: "POST",
    headers
  });
} else if (command === "disconnect") {
  const tenantId = argumentsAfterOrigin[0];
  if (!tenantId) fail("disconnect requires a tenant ID.");
  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}/disconnect`, {
    method: "POST",
    headers
  });
} else if (command === "reconcile-disconnect") {
  const tenantId = argumentsAfterOrigin[0];
  if (!tenantId) fail("reconcile-disconnect requires a tenant ID.");
  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}/reconcile-disconnect`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: `RECONCILE DISCONNECT ${tenantId}` })
  });
} else if (command === "delete") {
  const tenantId = argumentsAfterOrigin[0];
  if (!tenantId) fail("delete requires a tenant ID.");
  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}`, {
    method: "DELETE",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: `DELETE ${tenantId}` })
  });
} else {
  fail(`Unknown command: ${command}`);
}

const text = await response.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  payload = {
    ok: false,
    error: {
      code: "INVALID_ADMIN_RESPONSE",
      message: `The pilot service returned an unreadable response (HTTP ${response.status}, ${response.headers.get("content-type") ?? "unknown content type"}).`
    }
  };
}

if (!response.ok) {
  const code = payload?.error?.code ?? payload?.code ?? `HTTP_${response.status}`;
  const message = payload?.error?.message ?? "Pilot administration failed.";
  fail(`${code}: ${message}`);
}

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} catch (error) {
  const message = error instanceof PilotAdminError
    ? error.message
    : "Pilot administration failed unexpectedly.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function fail(message) {
  throw new PilotAdminError(message);
}
