# Architecture Notes

This POC is intentionally small. Keep future changes inside the existing boundaries unless a real requirement forces a new layer.

## Request Flow

```text
Twilio WhatsApp webhook
  -> normalizeInboundMessage
  -> load 24-hour conversation session by sender number
  -> classifyIntent
  -> extractFields
  -> resolveIntent
  -> InventoryProvider or delivery guidance
  -> AgentDecisionProvider
  -> applyResponseGuardrails
  -> Twilio send service
  -> admin review notification when human review is needed
  -> append inbound/outbound turns to session
  -> append persistent JSONL webhook event
```

## Intent Resolution

The classifier can be wrong or uncertain. Because this bot is read-only, the orchestrator leans toward attempting a useful product answer when extracted fields identify a known product.

Rules:

- `delivery_guidance` stays delivery guidance.
- Any recognized product keyword resolves to `check_availability`.
- Unknown product and no delivery signal resolves to `unclear`.
- First and second consecutive unclear turns ask focused clarifying questions.
- The third consecutive unclear inbound turn can escalate to human handoff.

This avoids the common WhatsApp bot failure where the user has to repeat a product query after a generic clarification prompt.

## Conversation Sessions

The POC keeps a lightweight in-memory session per WhatsApp sender for 24 hours. The session is keyed by the normalized Twilio `From` value and passed into `AgentDecisionRequest.conversation`.

The session stores:

- recent inbound/outbound turns
- extracted fields and resolved intent for each turn
- delivery guidance returned for delivery turns
- whether the automated-assistant disclosure was already sent

This lets the bot handle short follow-ups, such as `Bogota` after it asked for department and city. Because this is in-memory, sessions reset when the local server restarts. A production version should move this behind a small persistent store with retention limits.

The session also prevents over-eager escalation: the first two unclear messages get clarification attempts, while a third consecutive unclear inbound message can be handed to a human with a short acknowledgement.

## Persistent Trace Logs

Every webhook writes an append-only JSONL event to `WEBHOOK_EVENT_LOG_PATH`, defaulting to `.runtime/webhook-events.jsonl`.

Events include:

- normalized inbound message text and Twilio message id
- sender and recipient WhatsApp identifiers
- session id and participant key
- response text, send result, and human-routing outcome
- full processing trace, including intent, extracted fields, inventory matches, delivery guidance, agent decision, and guardrails
- failure records when processing throws

These logs are meant for later batch analysis and correction discovery. They contain customer message bodies and phone numbers, so keep them out of git and treat them as sensitive operational data.

## Agent Decision Layer

`AgentDecisionProvider` is the boundary for the local Codex-style decision engine.

Current modes:

- `deterministic`: in-process grounded fallback used for tests and local development.
- `local_cli`: sends the full decision request to `AGENT_LOCAL_CLI_COMMAND` over stdin and expects one JSON decision on stdout.

The CLI contract is documented in `docs/AGENT_CLI_CONTRACT.md`.

## Inventory Provider Contract

`InventoryProvider` returns display-safe availability records. The response layer should never assume a provider has exact stock unless the provider explicitly returns it.

Current mock records support:

- requested product/package matches
- alternatives
- upsells
- quantity checks
- read-only product URLs and notes

Future providers should preserve those ideas while staying read-only.

## Delivery Calculator Boundary

Delivery guidance is shaped around the store's public Shopify calculator: department + city/municipio go in, and domicile price plus estimated delivery window come out.

The current implementation in `src/delivery/deliveryGuidance.ts` fetches the public product page, extracts its embedded `shippingRatesByDepartment` calculator table, and caches it briefly. It should later be replaced by a read-only Shopify/API-backed adapter when the installation has an approved source for delivery rules.

Rules:

- ask for department and city/municipio when either is missing
- accept short location-only follow-ups during a pending delivery session
- do not invent prices or delivery windows
- describe delivery windows as estimates, not promises
- send a short acknowledgement and escalate when the calculator cannot return a grounded quote
- keep lookup behavior read-only and avoid storing personal delivery data beyond the processing trace needed for debugging

## Twilio Behavior

The webhook sends replies through Twilio's REST API and returns an empty TwiML response to acknowledge the webhook.

The app must remain reactive:

- no proactive sends
- no campaigns
- no scheduled outreach
- no order/cart/customer/ticket writes

The only secondary outbound message in the POC is an internal admin review notification triggered by an inbound customer message that needs human review.

## Testing Strategy

Use unit tests for deterministic business logic:

- classifier
- extractor
- mock inventory provider
- delivery guidance
- response composition
- orchestrator integration

Do not add automated tests that send real WhatsApp messages by default. Keep live Twilio testing manual or behind an explicit opt-in script.
