# PC-local operator inbox

## Safety boundary

The process exposes two isolated listeners:

- `WEBHOOK_PORT` (default `3000`) serves only `GET /health` and signed Twilio inbound/status webhooks.
- `127.0.0.1:OPERATOR_PORT` (default `3100`) serves the built UI, REST API, SSE stream, and opaque media URLs.

The operator listener is not reachable from other devices. Do not bind it to `0.0.0.0`. Phone access is intentionally deferred until a named Cloudflare Tunnel, deny-by-default Access policy, owner allowlist, and origin validation receive a separate deployment approval.

## Data and behavior

SQLite lives at `.runtime/operator-inbox.sqlite` and received media under `.runtime/media/`. Both paths, `.env`, settings, and logs are Git-ignored. Data remains until the operator confirms conversation deletion; there is no automatic hiding or archival.

Inbound messages are committed before the webhook acknowledgement. Provider SIDs deduplicate Twilio retries. Existing JSONL events are imported once when found. `ProfileName` and `WaId` are optional contact metadata; a local alias has display precedence without erasing the public name.

Inbound image, audio, and PDF files are fetched from Twilio HTTPS hosts with Twilio authentication, capped at 16 MB, stored with opaque identifiers, and served only by the local listener. A media-only inbound message enters human mode and is never given a guessed automated response.

An operator reply is limited to 1–1,600 characters, is available only on an existing inbound conversation while its 24-hour service window is open, and atomically switches the conversation to human mode before sending. While human mode is active, inbound messages are persisted but not auto-answered. **Reanudar bot** affects future inbound messages only.

## Operator settings

`operator-settings.example.json` is tracked. On first run it becomes `.runtime/operator-settings.json`:

```json
{
  "handoffMessage": "Voy a pasar tu conversación a una persona del equipo. La respuesta puede tardar un poco, pero tu mensaje quedó registrado y no lo vamos a perder."
}
```

The file contains no secrets. It is validated with Zod and hot-reloaded. Invalid edits produce a warning while the last valid value remains active. The owner may ask the active Codex installation to edit this local file. Twilio credentials belong exclusively in `.env`.

## Local API

- `GET /api/conversations`
- `GET /api/conversations/:id/messages`
- `PATCH /api/contacts/:id`
- `POST /api/conversations/:id/replies`
- `POST /api/conversations/:id/mode`
- `POST /api/conversations/:id/read`
- `DELETE /api/conversations/:id`
- `GET /api/media/:id`
- `GET /api/events`

The SSE stream announces conversation/message creation, message status, media readiness, alias, unread, deletion, settings, and automation-mode changes.

## Twilio activation checklist

Activation is intentionally not performed by setup or tests. After separate approval: configure credentials in `.env`, choose a stable signed public webhook URL, set both inbound and status callback paths, and run sandbox checks for profile-name capture, text/media, bot response, escalation, operator reply, delivery/read callbacks, restart persistence, and duplicate delivery.
