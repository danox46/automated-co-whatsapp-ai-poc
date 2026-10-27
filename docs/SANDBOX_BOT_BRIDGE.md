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
