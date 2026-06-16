# Agent Handoff

This repository is a read-only, reactive WhatsApp grocery advisor POC for Automated & Co.

## Prime Directives

- Keep the bot inbound-only.
- Do not add outreach, campaigns, scheduled sends, or proactive messaging.
- Do not add order creation, cart mutation, Shopify writes, CRM writes, ticket creation, or customer/product/inventory updates.
- Inventory integrations must remain read-only behind `InventoryProvider`.
- Prefer helpful attempts over generic clarification when a known product is detected.
- Do not add LLM calls until a later task explicitly asks for them.

## Current Runtime

- Node.js 20+
- TypeScript
- Express
- Twilio WhatsApp webhook + Twilio REST reply
- Mock grocery inventory provider
- Vitest tests

## Important Commands

```bash
npm install
npm run check:env
npm run verify
npm run demo
npm run dev
npm run tunnel
```

`npm run verify` is the main pre-handoff gate. It runs typecheck, tests, and build.

## Env Required For Live WhatsApp

```text
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_FROM
```

Use `.env.example` as the template. Never commit `.env`.

## Main Files

- `src/agent/orchestrator.ts`: request orchestration and attempt-first intent resolution
- `src/inventory/InventoryProvider.ts`: read-only provider contract
- `src/inventory/providers/mockInventoryProvider.ts`: current mock grocery catalog and alternatives
- `src/messages/extractFields.ts`: product, package size, quantity, and city extraction
- `src/responses/composeResponse.ts`: safe WhatsApp response text
- `src/twilio/webhookHandler.ts`: inbound webhook handling
- `src/twilio/sendService.ts`: Twilio REST send
- `public/mock-inventory.html`: static mock inventory viewer
- `docs/ARCHITECTURE.md`: architecture notes
- `docs/DEPLOYMENT.md`: deployment handoff

## Testing Expectations

Add or update tests when changing:

- matching keywords
- product extraction
- mock inventory substitutions
- advisory response wording
- intent resolution
- delivery estimates

Do not add automated tests that send live WhatsApp messages by default.

## Inventory Surface Roadmap

The next major design decision is the real inventory source. Before replacing the mock provider, decide how to represent:

- sellable availability vs exact stock
- package equivalence and substitutions
- related products and upsells
- display-safe product URLs
- out-of-stock alternatives
- read-only auth and API boundaries
