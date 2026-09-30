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
Twilio sender. Flow lookup is read-only; Flow creation and sending are not yet
exposed. A successful Flow list does not prove that Meta permits creating or
sending Flows on a test WABA.

The parallel bot must use its own encrypted inbox database, Codex home,
credential references, and local UI port. On first sync it imports existing
history without sending replies; only subsequent inbound text may enter its
5-second buffer when auto-reply is explicitly enabled.
