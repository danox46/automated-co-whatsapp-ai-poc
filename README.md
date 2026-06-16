# Automated & Co WhatsApp Grocery Advisor POC

Reactive WhatsApp assistant POC using Twilio. The bot is inbound-only and read-only: it answers product availability and delivery guidance questions, but it does not create orders, update Shopify, write to CRM, open tickets, send campaigns, or initiate proactive messages.

The current business loop uses mocked grocery inventory so the response behavior can be tested before connecting a real inventory surface.

## What It Does

- Receives inbound WhatsApp webhooks from Twilio
- Normalizes Twilio messages into an internal message shape
- Classifies simple delivery and availability requests
- Extracts product, package size, quantity, and city signals
- Looks up a mocked grocery inventory provider
- Leans toward attempting a helpful inventory answer when a known product is detected
- Can delegate final response decisions to a local CLI/Codex agent command
- Recommends real mock alternatives, such as replacing unavailable large mayo with medium jars
- Adds limited upsell suggestions only after the first query is answered
- Sends a WhatsApp response through Twilio's REST API
- Logs the full processing trace for debugging

## Current Mock Inventory

Open the static viewer:

[public/mock-inventory.html](./public/mock-inventory.html)

Products currently modeled:

- Mayonesa
- Arroz
- Leche entera
- Atun en lata

The source of truth for mocked inventory behavior is [src/inventory/providers/mockInventoryProvider.ts](./src/inventory/providers/mockInventoryProvider.ts).

## Environment

Copy the example file and fill the Twilio values:

```bash
cp .env.example .env
```

Required for live WhatsApp replies:

```text
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

Optional:

```text
PORT=3000
LOG_LEVEL=debug
TWILIO_WEBHOOK_PUBLIC_URL=
INVENTORY_PROVIDER=mock_grocery
AGENT_DECISION_MODE=deterministic
AGENT_LOCAL_CLI_COMMAND=
AGENT_LOCAL_CLI_TIMEOUT_MS=30000
```

Check runtime env:

```bash
npm run check:env
```

## Local Setup

```bash
npm install
npm run verify
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

Local demo without WhatsApp:

```bash
npm run demo
```

Local agent CLI contract docs:

[docs/AGENT_CLI_CONTRACT.md](./docs/AGENT_CLI_CONTRACT.md)

Mock local agent command:

```bash
npm run agent:mock
```

## Local Twilio Tunnel

Start the app in one terminal:

```bash
npm run dev
```

Start a public Cloudflare quick tunnel in a second terminal:

```bash
npm run tunnel
```

Cloudflare prints a temporary `https://...trycloudflare.com` URL. Configure Twilio's inbound WhatsApp webhook to:

```text
https://YOUR-TUNNEL-URL.trycloudflare.com/webhooks/twilio/whatsapp
```

Use `POST`. Quick tunnel URLs change when the tunnel restarts.

## Fresh Codex Handoff

For a new Codex instance or clean machine:

1. Clone the repo.
2. Install Node.js 20 or newer.
3. Run `npm install`.
4. Create `.env` from `.env.example`.
5. Add Twilio Account SID, Auth Token, and WhatsApp sender.
6. Run `npm run check:env`.
7. Run `npm run verify`.
8. Start the bot with `npm run dev`.
9. Start a tunnel with `npm run tunnel` if testing locally with Twilio.
10. Configure the Twilio WhatsApp webhook URL.

Useful smoke-test WhatsApp messages:

```text
Tienes mayonesa grande?
Necesito 2 mayonesas grandes
mayonesa grande
Tienen arroz de 5kg?
Tienen atun pack x6?
Cuanto tarda el envio a Bogota?
```

## Scripts

```text
npm run dev        Start local server in watch mode
npm run tunnel     Start Cloudflare quick tunnel to localhost:3000
npm run demo       Run local sample messages through the pipeline
npm run test       Run Vitest suite
npm run typecheck  Run TypeScript checks
npm run build      Clean and compile to dist
npm run verify     Typecheck, test, and build
npm run check:env  Validate required Twilio env vars
npm run agent:mock Mock local agent CLI contract implementation
```

## Architecture

```text
src/twilio        Twilio webhook and send service
src/messages      Message normalization and field extraction
src/intents       Lightweight classifier
src/agent         Orchestrator and processing trace
src/inventory     Provider interface and mock provider
src/delivery      Mock delivery estimates
src/responses     WhatsApp response composition
src/guardrails    Response safety checks
src/logging       JSON logger
src/local         Demo and environment check scripts
```

## Read-Only Rules

- Do not add order creation.
- Do not update Shopify products, inventory, customers, or orders.
- Do not write to CRM or ticketing systems.
- Do not send campaigns, outreach, or proactive messages.
- Keep Twilio replies reactive to inbound messages only.
- Future inventory providers must expose read-only lookup behavior behind `InventoryProvider`.

## Next Inventory Surface Questions

Before replacing the mock provider, decide:

- Which source is authoritative for availability?
- Whether availability is exact stock, sellable stock, or display-safe availability.
- Whether substitutions are configured in data, inferred from product metadata, or generated by an agent.
- How to model package equivalence, such as `2 medium mayo = 1 large mayo`.
- Whether upsells come from merchandising rules, collections, bundles, or product relationships.
