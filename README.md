# Automated & CO WhatsApp MCP and Advisor POC

The default runtime is a tenant-isolated Meta WhatsApp Cloud API MCP for a closed pilot. It includes one-time Embedded Signup, OAuth 2.1 with PKCE and resource-bound JWTs, durable structured conversation history, bounded retention, WABA-to-tenant webhook routing, policy-controlled replies/templates, and durable outbound idempotency. Twilio remains an explicit legacy path only.

While Meta Business Verification is pending, an app-owned test-number lane can
connect one internal sandbox tenant without pretending to onboard a client. It
uses a one-time owner link, a server-side recipient allowlist of at most five
Meta test recipients, and the same OAuth, tenant, consent, 24-hour-window,
template, and idempotency controls as the client pilot.

See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for the closed-pilot deployment and first-client runbook.

This repository contains two deliberately separated surfaces:

- the default policy-enforced Streamable HTTP MCP server plus an isolated signed Meta WhatsApp webhook; and
- a legacy reactive WhatsApp grocery-advisor POC using Twilio.

`npm run dev` and `npm start` now select the internal MCP. Twilio is never an automatic fallback: it starts only through `npm run dev:legacy:twilio`, `npm run start:legacy:twilio`, or an explicit `WHATSAPP_PROVIDER=legacy_twilio` setting. This preserves compatibility without making new work Twilio-first.

The Twilio advisor remains inbound-only and read-only: it answers product availability and delivery guidance questions, but it does not create orders, update Shopify, write to CRM, open tickets, send campaigns, or initiate proactive messages.

The MCP surface advertises explicit OpenAI-compatible tool annotations, structured output schemas, per-tool OAuth scopes, and actionable authentication challenges. Its persistent Worker uses one SQLite-backed Durable Object per authenticated tenant. Signed Meta events populate normalized conversation history, while connected agents receive only bounded tools and never raw payloads, provider identifiers, arbitrary SQL, or policy mutation. Provider-backed reply and approved-template tools are enabled only when the complete Meta and OAuth pilot configuration is present; otherwise the runtime fails closed. See [docs/WHATSAPP_MCP_POLICY.md](./docs/WHATSAPP_MCP_POLICY.md) and [docs/OPENAI_MCP_READINESS.md](./docs/OPENAI_MCP_READINESS.md).

Worker configuration is in `wrangler.mcp.jsonc`. Deployment state must be verified live before any invitation is issued. The data model and trust boundaries are documented in [docs/CONVERSATION_PERSISTENCE.md](./docs/CONVERSATION_PERSISTENCE.md).

The current business loop uses a copied mock snapshot of public grocery products so the response behavior can be tested before connecting a real inventory surface.

## Default Internal MCP Runtime

The default local runtime exposes:

- `GET /health` with an honest capability summary;
- `GET /.well-known/oauth-protected-resource` for MCP authorization discovery; and
- the Streamable HTTP MCP endpoint at `/mcp`.

It remains fail-closed locally: OAuth verification, durable conversation history, and provider-backed messaging are reported as disconnected. The Cloudflare Worker in `src/mcp/persistentWorker.ts` is the production-oriented persistence lane being improved separately.

## Legacy Twilio Advisor

- Receives inbound WhatsApp webhooks from Twilio only when the legacy runtime is explicitly selected
- Normalizes Twilio messages into an internal message shape
- Classifies simple delivery and availability requests
- Extracts product, package size, quantity, department, and city signals
- Looks up a mocked grocery inventory provider
- Leans toward attempting a helpful inventory answer when a known product is detected
- Can delegate final response decisions to a local CLI/Codex agent command
- Keeps a 24-hour in-memory conversation session per WhatsApp sender
- Waits 5 idle seconds to combine multi-part WhatsApp messages before processing
- Asks two clarifying questions before escalating unclear messages to a human
- Sends an admin WhatsApp notification when a conversation needs human review
- Recommends grounded mock alternatives, such as replacing an unavailable Canelitas pack with individual packages
- Answers delivery calculator questions with department/city, price, and estimated window from the public calculator page
- Adds limited upsell suggestions only after the first query is answered
- Sends a WhatsApp response through Twilio's REST API
- Persists webhook event logs with session and trace data for later analysis

## Current Mock Inventory

Open the static viewer:

[public/mock-inventory.html](./public/mock-inventory.html)

Products currently modeled:

- Diablitos Underwood
- Riko Malt 500Ml Venezuela
- Golden Manzanita lata 355 Ml Venezuela
- Canelitas Marinela
- Sopa de Pollo con Fideos Maggi 62g Venezuela

The source of truth for mocked inventory behavior is [src/inventory/providers/mockInventoryProvider.ts](./src/inventory/providers/mockInventoryProvider.ts).

## Environment

Copy the example file:

```bash
cp .env.example .env
```

The default is:

```text
WHATSAPP_PROVIDER=internal_mcp
WHATSAPP_MCP_RESOURCE_URL=http://localhost:3000
WHATSAPP_MCP_AUTHORIZATION_SERVER=https://auth.automatedandco.danienremoto.com
```

Twilio credentials are required only for the explicit legacy runtime:

```text
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_ADMIN_REVIEW_TO=whatsapp:+573006211340
```

Optional:

```text
PORT=3000
LOG_LEVEL=debug
WEBHOOK_EVENT_LOG_PATH=.runtime/webhook-events.jsonl
INBOUND_IDLE_BUFFER_MS=5000
TWILIO_WEBHOOK_PUBLIC_URL=
INVENTORY_PROVIDER=mock_grocery
AGENT_DECISION_MODE=deterministic
AGENT_LOCAL_CLI_COMMAND=npm run -s agent:codex
AGENT_LOCAL_CLI_TIMEOUT_MS=120000
AGENT_PROMPT_PATH=prompts/local-codex-agent.md
CODEX_CLI_PATH=
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

This starts the internal MCP. It does not send a WhatsApp message or silently switch to Twilio.

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

New Twilio account setup handoff:

[docs/CODEX_TWILIO_ACCOUNT_SETUP.md](./docs/CODEX_TWILIO_ACCOUNT_SETUP.md)

Mock local agent command:

```bash
npm run agent:mock
```

Local Codex agent command:

```bash
npm run agent:codex
```

Tune local Codex response behavior in [prompts/local-codex-agent.md](./prompts/local-codex-agent.md). That prompt contains the read-only rules, disclosure policy, human handoff rules, and response style guidance.

## Legacy Twilio Runtime And Tunnel

Start the legacy app explicitly in one terminal:

```bash
npm run dev:legacy:twilio
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
5. Keep `WHATSAPP_PROVIDER=internal_mcp` for new work.
6. Run `npm run check:env`.
7. Run `npm run verify`.
8. Start the internal MCP with `npm run dev`.
9. Only for a legacy compatibility test, add Twilio credentials and run `npm run dev:legacy:twilio`.
10. Start `npm run tunnel` and configure the Twilio webhook only for that explicit legacy test.

For a complete new-account checklist, use [docs/CODEX_TWILIO_ACCOUNT_SETUP.md](./docs/CODEX_TWILIO_ACCOUNT_SETUP.md).

Useful smoke-test WhatsApp messages:

```text
Tienen Riko Malt?
Que presentaciones de Golden Manzanita tienen?
Tienen Canelitas pack x3?
Cuanto cuesta el domicilio a Medellin, Antioquia?
Cuanto cuesta el domicilio?
Cuanto para Planeta Rica?
```

## Scripts

```text
npm run dev                   Start the default internal MCP in watch mode
npm run dev:mcp               Explicit alias for the default MCP runtime
npm run dev:legacy:twilio     Start the legacy Twilio runtime in watch mode
npm run start                 Start the compiled default internal MCP
npm run start:legacy:twilio   Start the compiled legacy Twilio runtime
npm run tunnel                Start Cloudflare quick tunnel to localhost:3000
npm run demo                  Run local sample messages through the legacy advisor pipeline
npm run test                  Run Vitest suite
npm run typecheck             Run TypeScript checks
npm run build                 Clean and compile to dist
npm run verify                Typecheck, test, and build
npm run check:env             Validate the selected runtime's required env vars
npm run agent:mock            Mock local agent CLI contract implementation
npm run agent:codex           Local Codex CLI agent bridge
```

## Architecture

```text
src/twilio        Twilio webhook and send service
src/messages      Message normalization and field extraction
src/intents       Lightweight classifier
src/agent         Orchestrator and processing trace
src/inventory     Provider interface and mock provider
src/delivery      Public Shopify delivery calculator adapter
src/responses     WhatsApp response composition
src/guardrails    Response safety checks
src/notifications Admin review notification composition
src/sessions      24-hour in-memory sender session context
src/logging       Console logger and persistent webhook event log
src/local         Demo and environment check scripts
src/mcp           MCP tools, tenant-scoped conversation storage, and policy enforcement
src/meta          Signed Meta webhook and normalized event ingestion
src/legacy        Explicit compatibility entrypoints; never selected silently
```

## Persistent Webhook Logs

Each Twilio webhook appends one JSON line to:

```text
.runtime/webhook-events.jsonl
```

Each event includes normalized inbound text, sender/recipient, batched message parts when present, session id, routing outcome, response text, Twilio send result, and the processing trace. This makes it possible to reconstruct back-and-forth sessions for later analysis and correction work.

These logs contain customer phone numbers and message bodies, so `.runtime/` is gitignored and the file should be treated as sensitive operational data.

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
- How to model package equivalence, such as `3 individual Canelitas = 1 pack x3`.
- Whether upsells come from merchandising rules, collections, bundles, or product relationships.

## Delivery Calculator Roadmap

The current delivery module reads the store's public Shopify calculator data from the product page: department + city/municipio in, domicile price and estimated delivery window out. A future production integration can replace this with an approved read-only Shopify/API-backed source without changing the response pipeline.

When replacing the mock, keep it read-only and polite: respect site terms, avoid bypassing auth or anti-abuse controls, rate-limit requests, cache when reasonable, and do not collect personal data beyond what the customer provided for the delivery quote.
