#!/usr/bin/env node

class PilotAdminError extends Error {}

try {
const [command, baseUrl, ...argumentsAfterOrigin] = process.argv.slice(2);
const adminToken = process.env.PILOT_ADMIN_TOKEN;

if (!adminToken || !command || !baseUrl) {
  fail("Usage: PILOT_ADMIN_TOKEN=<secret> npm run pilot:admin -- <sandbox-invite|sandbox-reinvite|invite|reinvite|status|disconnect|delete> <https-origin> [tenant-id] [label] [internal|client]");
}

const origin = new URL(baseUrl).origin;
const headers = { Authorization: `Bearer ${adminToken}` };
let response;

if (command === "sandbox-invite" || command === "sandbox-reinvite") {
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
} else if (command === "disconnect") {
  const tenantId = argumentsAfterOrigin[0];
  if (!tenantId) fail("disconnect requires a tenant ID.");
  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}/disconnect`, {
    method: "POST",
    headers
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
  payload = { ok: false, error: { code: "INVALID_ADMIN_RESPONSE", message: "The pilot service returned an unreadable response." } };
}

if (!response.ok) {
  const code = payload?.error?.code ?? `HTTP_${response.status}`;
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
