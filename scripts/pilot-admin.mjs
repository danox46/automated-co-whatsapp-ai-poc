#!/usr/bin/env node

const [command, baseUrl, tenantId, ...rest] = process.argv.slice(2);
const adminToken = process.env.PILOT_ADMIN_TOKEN;

if (!adminToken || !command || !baseUrl || !tenantId) {
  fail("Usage: PILOT_ADMIN_TOKEN=<secret> npm run pilot:admin -- <invite|status|disconnect|delete> <https-origin> <tenant-id> [label] [internal|client]");
}

const origin = new URL(baseUrl).origin;
const headers = { Authorization: `Bearer ${adminToken}` };
let response;

if (command === "invite") {
  const label = rest[0];
  const cohortRole = rest[1] ?? "client";
  if (!label) fail("The invite command requires a human-readable pilot label.");
  response = await fetch(`${origin}/admin/pilot/invitations`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, label, cohortRole, expiresInHours: 24 })
  });
} else if (command === "status") {
  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}`, { headers });
} else if (command === "disconnect") {
  response = await fetch(`${origin}/admin/pilot/installations/${encodeURIComponent(tenantId)}/disconnect`, {
    method: "POST",
    headers
  });
} else if (command === "delete") {
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

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
