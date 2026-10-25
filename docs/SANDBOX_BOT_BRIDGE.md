# Parallel Meta sandbox bot bridge

The app-owned Meta test number remains on the existing MCP webhook. A separate
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
Twilio sender. Flow lookup is read-only on the bot bridge. A separate pilot
admin route can create, validate and publish only the named visit and wholesale
sandbox Flows. The agent credential cannot invoke it. Flow sending is not yet
exposed to the bot.

Meta accepted both JSON assets with zero validation errors as drafts on the
app-owned test WABA. Publishing the visit draft returned Graph error `139000`;
the draft remained intact. Do not enable the Flow tool until this account gate
is resolved and a controlled send/submit canary passes.

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
This is not Flow acceptance: the current sandbox bot supports text only, the
visit and wholesale Flows remain drafts, and structured form launch/results
still need their own transport and phone canary. Historical error 139000 is not
a current retest. Owner hold: no App Review, template or Flow submission or
publication until Daniel lifts the gate.
