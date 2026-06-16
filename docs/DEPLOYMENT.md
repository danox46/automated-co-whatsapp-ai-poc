# Deployment Handoff

This app can run anywhere that supports Node.js 20+ and HTTPS ingress.

## Required Secrets

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_FROM
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
AGENT_LOCAL_CLI_TIMEOUT_MS=30000
```

Use `AGENT_DECISION_MODE=deterministic` when the local Codex command is not available.

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

## Production Notes

- Use a stable public HTTPS URL, not a Cloudflare quick tunnel.
- Rotate trial credentials before production use.
- Keep inventory read-only.
- Add Twilio request signature validation before handling real production traffic.
- Add durable request logging or observability before production traffic.
- Consider idempotency for retried Twilio webhooks before production traffic.
