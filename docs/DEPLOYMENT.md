# Deployment Handoff

This app can run anywhere that supports Node.js 20+ and HTTPS ingress.

## Required Secrets

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_FROM
TWILIO_ADMIN_REVIEW_TO
```

For local development, put these in `.env`. For production, set them in the hosting platform's secret manager.

## Commands

```bash
npm ci
npm run verify
npm run check:env
npm run build
npm start
```

For local-Codex decision mode, also set:

```text
AGENT_DECISION_MODE=local_cli
AGENT_LOCAL_CLI_COMMAND=<command that reads JSON stdin and prints AgentDecision JSON>
AGENT_LOCAL_CLI_TIMEOUT_MS=120000
```

Use `AGENT_DECISION_MODE=deterministic` when the local Codex command is not available.

Webhook processing events are appended to:

```text
WEBHOOK_EVENT_LOG_PATH=.runtime/webhook-events.jsonl
INBOUND_IDLE_BUFFER_MS=5000
```

Use a persistent volume or managed log sink in production if these records should survive deploys/restarts. The log contains customer phone numbers and message bodies.

## Health Check

```text
GET /health
```

Expected:

```json
{"ok":true,"service":"automated-co-whatsapp-ai-poc"}
```

## Twilio Webhook

Configure Twilio WhatsApp inbound webhook:

```text
POST https://YOUR-PUBLIC-HOST/webhooks/twilio/whatsapp
```

When the agent routes a conversation to human review, the app sends an internal WhatsApp alert to `TWILIO_ADMIN_REVIEW_TO`.

## Production Notes

- Use a stable public HTTPS URL, not a Cloudflare quick tunnel.
- Rotate trial credentials before production use.
- Keep inventory read-only.
- Add Twilio request signature validation before handling real production traffic.
- Replace local JSONL logging with durable observability before production traffic.
- Consider idempotency for retried Twilio webhooks before production traffic.
