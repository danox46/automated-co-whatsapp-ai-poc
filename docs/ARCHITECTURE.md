# Architecture Notes

This POC is intentionally small. Keep future changes inside the existing boundaries unless a real requirement forces a new layer.

## Request Flow

```text
Twilio WhatsApp webhook
  -> normalizeInboundMessage
  -> classifyIntent
  -> extractFields
  -> resolveIntent
  -> InventoryProvider or delivery guidance
  -> composeResponse
  -> applyResponseGuardrails
  -> Twilio send service
```

## Intent Resolution

The classifier can be wrong or uncertain. Because this bot is read-only, the orchestrator leans toward attempting a useful product answer when extracted fields identify a known product.

Rules:

- `delivery_guidance` stays delivery guidance.
- Any recognized product keyword resolves to `check_availability`.
- Unknown product and no delivery signal resolves to `unclear`.

This avoids the common WhatsApp bot failure where the user has to repeat a product query after a generic clarification prompt.

## Inventory Provider Contract

`InventoryProvider` returns display-safe availability records. The response layer should never assume a provider has exact stock unless the provider explicitly returns it.

Current mock records support:

- requested product/package matches
- alternatives
- upsells
- quantity checks
- read-only product URLs and notes

Future providers should preserve those ideas while staying read-only.

## Twilio Behavior

The webhook sends replies through Twilio's REST API and returns an empty TwiML response to acknowledge the webhook.

The app must remain reactive:

- no proactive sends
- no campaigns
- no scheduled outreach
- no order/cart/customer/ticket writes

## Testing Strategy

Use unit tests for deterministic business logic:

- classifier
- extractor
- mock inventory provider
- delivery guidance
- response composition
- orchestrator integration

Do not add automated tests that send real WhatsApp messages by default. Keep live Twilio testing manual or behind an explicit opt-in script.
