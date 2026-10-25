# Parallel Meta sandbox bot bridge

## Dedicated Morning line (25 October 2026)

The internal test configuration now targets Morning ARP's dedicated Cloud API
line, not Meta's disposable test sender. The tenant, OAuth scopes, protected
credentials and recipient allowlist are retained. The visit and wholesale
catalog IDs refer to copies in the new messaging account; both remain drafts.
Creation, migration and tests do not authorize publishing them or App Review.

Changing configured assets is followed by the existing authenticated
`refresh-sandbox-credential` admin operation. It verifies phone ownership,
subscribes the app, registers allowlisted conversation references and stores
the installation. A deployment alone does not complete the connection.
Registry refresh removes the superseded WABA route; webhook routing also
requires a currently connected installation matching the incoming WABA.
Historical conversations and original send receipts remain intact. Their old
sender references cannot borrow the new sender's reply window.

For rollback, deploy this same routing-aware source with the four original
configuration overrides, then refresh the installation and independently verify
provider status and bridge reads. Do not roll back to older code lacking the
routing checks or delete/reseed retained conversation data:

```powershell
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.mcp.jsonc `
  --var META_SANDBOX_WABA_ID:934775242587261 `
  --var META_SANDBOX_PHONE_NUMBER_ID:1319674237902829 `
  --var META_SANDBOX_VISIT_FLOW_ID:2272570040204107 `
  --var META_SANDBOX_WHOLESALE_FLOW_ID:1112123734847750
./scripts/pilot-admin.ps1 refresh-sandbox-credential https://automated-co-whatsapp-mcp.danielx9.workers.dev morning-arp-sandbox
./scripts/pilot-admin.ps1 provider-status https://automated-co-whatsapp-mcp.danielx9.workers.dev morning-arp-sandbox
```

Reconcile the local bot's mode, pending work and original outbound keys before
either switch. Genuine inbound, reply, delivery and draft-completion receipts
are still required for acceptance; provider account setup is not bot acceptance.

For an uncertain send, the existing owner admin credential can read at most the
latest 20 dispatch receipts for one exact tenant/conversation:
`pilot-admin.ps1 dispatches <origin> <tenant> <conversationRef>`. This read-only
route returns original keys and reservation/completion state, without message
text or credentials. `reserved` means the outcome remains unconfirmed; elapsed
time, empty history or a separate billing warning is not proof of rejection.
Never turn this diagnostic into a resend, replacement key or direct database edit.

## Historical Meta test-number setup

The app-owned Meta test number used the existing MCP webhook. A separate
bot may mirror its conversations through these fixed, single-tenant routes:

- `GET /bot/sandbox/conversations`
- `GET /bot/sandbox/conversations/{conversationRef}/history`
- `POST /bot/sandbox/conversations/{conversationRef}/replies`
- `GET /bot/sandbox/flows`

All routes require the `SANDBOX_BOT_BRIDGE_TOKEN` Worker secret. Keep the token
in the host's secure store and never put it in a URL or log. The bridge only
uses the configured sandbox WABA and recipient allowlist. Replies use the
existing verified 24-hour window, opt-out, automation-pause, and durable
idempotency checks. It does not alter the webhook subscription or production
Twilio sender. Flow lookup is read-only. The candidate implementation also
exposes a named draft-send route and MCP tool, described below. A separate
pilot admin route can create, validate and publish only the named visit and
wholesale sandbox Flows; the bot credential cannot invoke that admin route.

Meta accepted both JSON assets with zero validation errors as drafts on the
app-owned test WABA. Publishing the visit draft returned Graph error `139000`;
the draft remained intact. This is historical publication evidence, not a
current send failure. Publication is not required for draft-mode device tests.

The parallel bot must use its own encrypted inbox database, Codex home,
credential references, and local UI port. On first sync it imports existing
history without sending replies; only subsequent inbound text may enter its
5-second buffer when auto-reply is explicitly enabled.

## Restoration verification (24 October 2026)

A deployment from the older policy branch omitted this bridge while direct MCP
messaging tests still passed. Local Sol remained running but its bridge reads
received 404. Treat direct MCP acceptance and bot synchronization as separate
checks. The current restoration candidate starts from bridge commit 49cc42b,
preserving its dispatch-authorization, retention and provider-deadline fixes,
and carries forward the Morning policy URLs and signup callback deduplication.

`npm run verify:mcp` now includes `sandboxBridgeRouting.worker.test.ts`, which
checks the actual configured Worker export: health advertises the bridge;
unauthenticated conversation/history/reply/Flow routes return 401, not 404;
authenticated reads remain bound to the synthetic sandbox tenant. These tests
use isolated local Durable Objects and never contact Meta or send messages.

Before restoration, inspect and reconcile the running poller's auto-reply gate,
unseen messages and buffered work. Restoring the endpoint alone can cause an
already-running poller to queue previously unseen inbound text. Do not reset its
baseline, delete receipts or blindly restart/replay messages. Preserve any
uncertain outbound operation under its original idempotency key.

Deployment acceptance requires independent live route/health checks and fresh
local Sol synchronization, followed by controlled owner-number acceptance.
This restoration was not Flow acceptance. The running Sol client still needs
its draft-Flow adapter and phone canary. Historical error 139000 is not a
current retest. Owner hold: no App Review/template submission or Flow
publication until Daniel lifts the gate. Manual draft completion is a test,
not publication.

## Draft-Flow candidate (not deployed or phone-accepted)

The candidate uses the existing sandbox WABA/sender, original OAuth scope
`whatsapp.messages.send`, tenant and recipient allowlist. It never publishes a
Flow or accepts arbitrary Graph payloads, destinations or Flow IDs from agents.

- MCP: `whatsapp_send_flow({ conversationRef, flowType, idempotencyKey, text? })`.
- Bridge: `POST /bot/sandbox/conversations/{conversationRef}/flows` with
  `{ "flowType": "visit", "idempotencyKey": "original-intent-key" }`.
- `flowType` is `visit` or `wholesale`; IDs are server-owned configuration.
- Optional `text` is a 1–1024 character introduction, frozen into the original
  intent and stored exactly as dispatched. It cannot change recipient, Flow
  ID, screen, mode or CTA. Omission uses the server's existing default text.
- The tool registers only when the sandbox Flow service is configured. It uses
  the existing write scope; normal account authorization still applies.
- The server verifies the selected named draft belongs to the connected WABA,
  then reserves the send under authoritative window/opt-out/handoff checks.
  Flow parameters always use `mode: "draft"` and message version `3`.
- Original-key retries return a completed receipt or reconciliation error.
  Uncertain provider operations are never sent again. Concrete rejections are
  distinguished from unknown outcomes; preserve the original receipt and key.

Before provider I/O the server stores a secret-bound token hash and its tenant,
conversation, form and original intent. Raw tokens/webhook JSON are not stored.
Signed `nfm_reply.response_json` is parsed against exact bounded schemas from
the existing visit/wholesale assets. Matching checks conversation, form kind,
original outbound context when known, expiry and first-completion receipt. The
message and first-completion claim commit atomically.

History adds optional `flowSubmission`:
`{ status: "completed", form: { kind: "visit", answers: { ... } } }`, or
payload-free `invalid`, `unmatched` or `duplicate`. User-entered phone/name are
form answers, not provider account identifiers. Invalid/unmatched replies need
review; never infer booking, fulfillment, payment or approval from completion.

Answers share their parent message's retention/deletion. Correlation hashes
expire after at most seven days and are removed during retention/prune or
conversation deletion. No CRM, order, bank or inventory write is added.

Local tests cover SQLite reconstruction, signed ingress, tenant/conversation
boundaries, SDK/schema contracts, parallel sends, uncertain original-key
recovery and cleanup. This is synthetic local proof, not Meta delivery or phone
acceptance. Finish the Sol adapter before rollout; reconcile original receipts
from both intended-phone canaries before claiming end-to-end readiness.

Primary contracts checked 24 October 2026:
- https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/testingdebugging/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/sendingaflow
- https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/flowswebhooks/
