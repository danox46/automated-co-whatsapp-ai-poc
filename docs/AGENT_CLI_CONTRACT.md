# Local Agent CLI Contract

The WhatsApp app can delegate final response decisions to a local agent command. This is intended for a local Codex instance or wrapper script.

The app remains read-only. The local agent receives a grounded inventory snapshot and returns either:

- `respond`: send this WhatsApp response
- `route_to_human`: do not send an automated answer; log that a human should handle it

## Enable CLI Mode

```text
AGENT_DECISION_MODE=local_cli
AGENT_LOCAL_CLI_COMMAND=<your command>
AGENT_LOCAL_CLI_TIMEOUT_MS=30000
```

For local contract testing:

```text
AGENT_DECISION_MODE=local_cli
AGENT_LOCAL_CLI_COMMAND=npm run -s agent:mock
```

## Input

The command receives one JSON object on stdin with:

- `message`: normalized inbound WhatsApp message
- `extracted`: product, quantity, package size, and city signals
- `catalog`: read-only product and variant snapshot
- `inventoryMatches`: deterministic requested/alternative/upsell matches when available
- `deliveryGuidance`: delivery estimate object when available

The local agent should only recommend products and variants present in `catalog`, `inventoryMatches`, or `deliveryGuidance`.

## Output

The command must print exactly one JSON object to stdout:

```json
{
  "action": "respond",
  "responseText": "Para Arroz, tenemos estas presentaciones: bolsa 5kg, bolsa 1kg.",
  "confidence": 0.82,
  "understanding": {
    "intent": "unclear",
    "resolvedIntent": "catalog_options",
    "needsHuman": false
  },
  "notes": ["Answered from catalog variants only."]
}
```

For human routing:

```json
{
  "action": "route_to_human",
  "routeReason": "Customer is asking about an unsupported refund request.",
  "confidence": 0.4,
  "understanding": {
    "intent": "unclear",
    "resolvedIntent": "unclear",
    "needsHuman": true
  },
  "notes": ["No grounded inventory or delivery answer available."]
}
```

## Output Schema

```ts
type AgentDecision = {
  action: "respond" | "route_to_human";
  responseText?: string;
  routeReason?: string;
  confidence: number;
  understanding: {
    intent: "check_availability" | "delivery_guidance" | "unclear";
    resolvedIntent:
      | "check_availability"
      | "delivery_guidance"
      | "unclear"
      | "catalog_options";
    needsHuman: boolean;
  };
  notes: string[];
};
```

## Suggested Local Codex Prompt Shape

```text
You are the read-only WhatsApp inventory advisor for Automated & Co.
Use only the provided catalog, inventoryMatches, and deliveryGuidance.
Do not invent products, prices, stock, URLs, orders, or delivery promises.
Decide whether to respond or route_to_human.
Return only valid JSON matching the AgentDecision schema.
Prefer a useful grounded attempt when a known product is detected.
Route to human when the request is outside inventory/delivery guidance or cannot be answered from the provided data.
```

Keep stdout clean. Logs or commentary should go to stderr.
