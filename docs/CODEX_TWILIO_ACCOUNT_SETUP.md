# Codex Setup Report: New Twilio WhatsApp Account

This report is the handoff checklist for a fresh Codex instance setting up this read-only WhatsApp auto-responder with a different Twilio account.

## Goal

Run the Automated & Co WhatsApp grocery advisor POC with a new Twilio WhatsApp Sandbox or WhatsApp sender.

The app must remain:

- inbound-only
- reactive to customer WhatsApp messages
- read-only for inventory, delivery, Shopify, CRM, tickets, customers, products, and orders
- limited to answering grounded product availability, product options, substitutions, and delivery guidance

## Repository Entry Points

- `AGENTS.md`: operating rules for Codex in this repo
- `README.md`: local setup, scripts, architecture summary
- `docs/DEPLOYMENT.md`: deployment notes
- `docs/AGENT_CLI_CONTRACT.md`: local agent command contract
- `prompts/local-codex-agent.md`: local Codex response policy
- `src/config/env.ts`: runtime environment contract
- `src/twilio/webhookHandler.ts`: inbound webhook path
- `src/twilio/sendService.ts`: outbound Twilio reply service
- `src/inventory/providers/mockInventoryProvider.ts`: current copied mock catalog
- `src/delivery/deliveryGuidance.ts`: public delivery calculator lookup

## Prerequisites

- Node.js 20+
- npm
- Git
- A Twilio account with WhatsApp Sandbox enabled, or an approved WhatsApp sender
- A public HTTPS URL for webhooks

For local testing, this repo uses Cloudflare quick tunnels:

```bash
npm run tunnel
```

For production or long-running testing, use a stable HTTPS host. Quick tunnel URLs change whenever the tunnel restarts.

## Fresh Clone Setup

```bash
git clone <repo-url>
cd <repo-folder>
npm install
cp .env.example .env
```

On Windows PowerShell, if `cp` is unavailable:

```powershell
Copy-Item .env.example .env
```

Fill `.env` with the new account values.

## Required Environment Variables

```text
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=
TWILIO_ADMIN_REVIEW_TO=
```

Expected formats:

```text
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=<new account auth token>
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_ADMIN_REVIEW_TO=whatsapp:+57XXXXXXXXXX
```

For the Twilio Sandbox, `TWILIO_WHATSAPP_FROM` is usually the sandbox sender shown in Twilio Console, commonly `whatsapp:+14155238886`.

Optional but useful:

```text
PORT=3000
LOG_LEVEL=debug
WEBHOOK_EVENT_LOG_PATH=.runtime/webhook-events.jsonl
INBOUND_IDLE_BUFFER_MS=5000
TWILIO_WEBHOOK_PUBLIC_URL=https://YOUR-PUBLIC-HOST
INVENTORY_PROVIDER=mock_grocery
AGENT_DECISION_MODE=deterministic
AGENT_LOCAL_CLI_COMMAND=npm run -s agent:codex
AGENT_LOCAL_CLI_TIMEOUT_MS=120000
AGENT_PROMPT_PATH=prompts/local-codex-agent.md
CODEX_CLI_PATH=
```

Use `AGENT_DECISION_MODE=deterministic` for the simplest new-account smoke test. Switch to `local_cli` only after the local Codex bridge is working.

## Validation Before Twilio

Run:

```bash
npm run check:env
npm run verify
npm run demo
```

Expected:

- `check:env` passes
- `verify` runs typecheck, tests, and build
- `demo` prints local sample processing results without using Twilio

## Start The Local App

Terminal 1:

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

Expected:

```json
{"ok":true,"service":"automated-co-whatsapp-ai-poc"}
```

## Start A Public Tunnel

Terminal 2:

```bash
npm run tunnel
```

Cloudflare prints a URL like:

```text
https://example-name.trycloudflare.com
```

Set:

```text
TWILIO_WEBHOOK_PUBLIC_URL=https://example-name.trycloudflare.com
```

Public health check:

```bash
curl https://example-name.trycloudflare.com/health
```

Expected:

```json
{"ok":true,"service":"automated-co-whatsapp-ai-poc"}
```

## Configure Twilio WhatsApp Sandbox

Official Twilio docs say the WhatsApp Sandbox webhook is configured in the Sandbox settings, in the `When a Message Comes In` field. Use `POST`.

Inbound webhook URL:

```text
https://example-name.trycloudflare.com/webhooks/twilio/whatsapp
```

Twilio Console path may vary, but the current docs describe:

- Open the Twilio WhatsApp Sandbox / Try WhatsApp page
- Open Sandbox settings / Sandbox configuration
- Set `When a Message Comes In`
- Method: `POST`
- Save

Reference:

- Twilio Sandbox docs: https://www.twilio.com/docs/whatsapp/sandbox
- Twilio WhatsApp quickstart: https://www.twilio.com/docs/whatsapp/quickstart
- Twilio webhooks overview: https://www.twilio.com/docs/usage/webhooks/getting-started-twilio-webhooks

## Join The Sandbox From A Test Phone

In Twilio Console, copy the sandbox join phrase and send it from the test WhatsApp phone to the Twilio sandbox number.

The phone must join the new account's sandbox before it can exchange messages with that sandbox.

## Manual Smoke Tests

Send these from WhatsApp after joining the sandbox:

```text
Tienen Riko Malt?
Que presentaciones de Golden Manzanita tienen?
Tienen Canelitas pack x3?
Cuanto cuesta el domicilio?
Antioquia Medellin
Cuanto para Planeta Rica?
```

Expected behavior:

- Product questions receive grounded answers from the copied mock catalog.
- Unavailable packs can receive grounded alternatives.
- Delivery questions ask for missing department/city.
- Location follow-ups are handled inside the 24-hour sender session.
- Delivery price and estimate come from the public calculator page.
- Unclear messages clarify twice before human review routing.
- Human-review routing sends a WhatsApp admin alert to `TWILIO_ADMIN_REVIEW_TO`.

## Confirm Webhook Activity

Webhook events are appended to:

```text
.runtime/webhook-events.jsonl
```

Check the latest entries:

```bash
tail -n 5 .runtime/webhook-events.jsonl
```

PowerShell:

```powershell
Get-Content .runtime\webhook-events.jsonl -Tail 5
```

Each event should include:

- inbound Twilio message id
- sender and recipient WhatsApp identifiers
- batched message parts
- session id
- extracted fields
- intent and resolved intent
- inventory matches or delivery guidance
- response text
- Twilio send result
- guardrail result

Treat this file as sensitive because it contains phone numbers and message bodies.

## Outbound Reply Check

The app replies through Twilio's Messages API using:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- inbound sender number from the webhook

Do not add proactive sends. Outbound messages should only be replies caused by inbound customer messages, except the internal admin review notification.

## Common Failure Modes

### Local health fails

Check whether the dev server is running:

```bash
npm run dev
```

Then retry:

```bash
curl http://localhost:3000/health
```

### Public health fails

The tunnel may have stopped or changed URL.

Restart:

```bash
npm run tunnel
```

Update Twilio's `When a Message Comes In` URL with the new tunnel URL.

### Twilio receives messages but app does not

Check:

- Sandbox phone joined the correct Twilio account sandbox
- Twilio Sandbox `When a Message Comes In` URL is the current public URL
- Method is `POST`
- URL path ends in `/webhooks/twilio/whatsapp`
- Public health endpoint works
- No old quick tunnel URL is still configured

### App receives inbound but customer gets no reply

Check:

- `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` belong to the same account as the sandbox
- `TWILIO_WHATSAPP_FROM` is the sandbox or approved sender for that account
- The test phone has joined the sandbox
- `.runtime/webhook-events.jsonl` has a `sendResult` or failure record

### Admin review alert does not arrive

Check:

- `TWILIO_ADMIN_REVIEW_TO` is set as `whatsapp:+<countrycode><number>`
- Admin phone joined the same sandbox when using Twilio Sandbox
- The message actually routed to human review

## New Account Checklist

Use this as the minimum done checklist:

- [ ] `.env` created from `.env.example`
- [ ] New account `TWILIO_ACCOUNT_SID` set
- [ ] New account `TWILIO_AUTH_TOKEN` set
- [ ] New account sandbox/WhatsApp sender set in `TWILIO_WHATSAPP_FROM`
- [ ] Admin review number set in `TWILIO_ADMIN_REVIEW_TO`
- [ ] `npm run check:env` passes
- [ ] `npm run verify` passes
- [ ] `npm run dev` health check passes
- [ ] Public tunnel or stable HTTPS host health check passes
- [ ] Twilio Sandbox inbound webhook points to `/webhooks/twilio/whatsapp`
- [ ] Test phone joined the correct sandbox
- [ ] Product smoke test receives reply
- [ ] Delivery smoke test receives reply
- [ ] `.runtime/webhook-events.jsonl` shows the processing trace

## Production Notes

Before real production traffic:

- Use a stable HTTPS host instead of Cloudflare quick tunnel.
- Rotate trial/test credentials.
- Add Twilio request signature validation.
- Move webhook trace logging to durable storage with a retention policy.
- Add idempotency for Twilio webhook retries.
- Keep inventory and delivery integrations read-only.
- Do not add campaigns, scheduled sends, outreach, order creation, cart mutation, CRM writes, ticket creation, or Shopify writes.

