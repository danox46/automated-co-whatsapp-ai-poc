# Agent Handoff

This repository contains a legacy read-only Twilio grocery advisor and a separate policy-enforced Meta WhatsApp MCP surface for Automated & CO.

## Prime Directives

- Treat the internal Streamable HTTP MCP runtime as the default executable lane for all new work.
- Start the Twilio runtime only through the explicit legacy entrypoint or `WHATSAPP_PROVIDER=legacy_twilio`; do not silently fall back to Twilio when the MCP is unavailable.
- Keep the legacy Twilio advisor inbound-only.
- Do not add outreach, campaigns, scheduled sends, or proactive messaging.
- Do not add order creation, cart mutation, Shopify writes, CRM writes, ticket creation, or customer/product/inventory updates.
- Inventory integrations must remain read-only behind `InventoryProvider`.
- Prefer helpful attempts over generic clarification when a known product is detected.
- Do not escalate the first two unclear messages. Ask focused clarifications first; escalate on the third consecutive unclear inbound turn or clear human-only topics.
- Do not add LLM calls until a later task explicitly asks for them.
- Provider-backed MCP reply and approved-template tools may be developed only behind the server-owned OAuth, tenant, consent, service-window, idempotency, and human-handoff contracts in `docs/WHATSAPP_MCP_POLICY.md`.
- Do not describe an MCP tool as read-only, idempotent, private, or reversible unless its implementation and advertised annotations prove that claim.
- Connected agents may read only bounded, normalized, tenant-scoped conversation data. Do not expose raw webhook payloads, provider identifiers, arbitrary queries, history mutation, or policy overrides through MCP tools.
- Internal trusted application code may ingest messages and update delivery, opt-out, handoff, consent, and enforcement state. Keep that write boundary separate from the connected-agent tool surface.

## Current Runtime

- Node.js 20+
- TypeScript
- Express
- Twilio WhatsApp webhook + Twilio REST reply
- Mock grocery inventory provider
- Vitest tests
- Streamable HTTP MCP server with OpenAI submission metadata
- Signed, size-limited Meta WhatsApp webhook
- Internal MCP local server as the default `dev` and `start` runtime
- Explicit legacy Twilio `dev:legacy:twilio` and `start:legacy:twilio` entrypoints

## Important Commands

```bash
npm install
npm run check:env
npm run verify
npm run demo
npm run dev
npm run tunnel
npm run agent:mock
npm run agent:codex
npm run test:mcp-policy
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
- `src/agent/decisionTypes.ts`: local agent decision contract
- `src/agent/localCliDecisionProvider.ts`: JSON stdin/stdout bridge for local Codex-style commands
- `prompts/local-codex-agent.md`: runtime prompt for the local Codex decision agent
- `src/sessions/conversationSessionStore.ts`: 24-hour in-memory sender session context
- `src/logging/webhookEventLog.ts`: append-only JSONL webhook trace log
- `src/notifications/adminReviewNotification.ts`: internal WhatsApp review alert text
- `src/inventory/InventoryProvider.ts`: read-only provider contract
- `src/inventory/providers/mockInventoryProvider.ts`: current mock grocery catalog and alternatives
- `src/messages/extractFields.ts`: product, package size, quantity, department, and city extraction
- `src/delivery/deliveryGuidance.ts`: mock Shopify delivery calculator adapter
- `src/responses/composeResponse.ts`: safe WhatsApp response text
- `src/twilio/webhookHandler.ts`: inbound webhook handling
- `src/twilio/sendService.ts`: Twilio REST send
- `src/mcp/server.ts`: MCP tools, output schemas, annotations, OAuth metadata, and auth challenges
- `src/mcp/outboundPolicy.ts`: server-owned reply and template dispatch policy
- `src/mcp/conversationHistory.ts`: normalized conversation models plus internal read/write contracts
- `src/mcp/durableConversationStore.ts`: tenant-sharded SQLite Durable Object persistence
- `src/mcp/persistentWorker.ts`: local combined webhook, persistence, and MCP Worker entry point
- `src/mcp/worker.ts`: deny-all MCP deployment entry point until OAuth/provider wiring exists
- `src/meta/conversationEvents.ts`: signed-webhook normalization into bounded stored records
- `src/meta/webhook.ts`: isolated signed Meta webhook
- `docs/OPENAI_MCP_READINESS.md`: technical public-submission readiness contract
- `docs/CONVERSATION_PERSISTENCE.md`: storage schema, trust boundaries, and production gaps
- `public/mock-inventory.html`: static mock inventory viewer
- `docs/ARCHITECTURE.md`: architecture notes
- `docs/DEPLOYMENT.md`: deployment handoff
- `docs/AGENT_CLI_CONTRACT.md`: command contract for external/local agents

## Testing Expectations

Add or update tests when changing:

- matching keywords
- product extraction
- mock inventory substitutions
- advisory response wording
- intent resolution
- delivery estimates
- delivery calculator source behavior

Do not add automated tests that send live WhatsApp messages by default.

## Inventory Surface Roadmap

The next major design decision is the real inventory source. Before replacing the mock provider, decide how to represent:

- sellable availability vs exact stock
- package equivalence and substitutions
- related products and upsells
- display-safe product URLs
- out-of-stock alternatives
- read-only auth and API boundaries
- public delivery calculator lookup and caching behavior
