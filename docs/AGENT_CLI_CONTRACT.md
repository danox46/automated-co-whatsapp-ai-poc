# Local Agent CLI Contract

The WhatsApp app can delegate final response decisions to a local agent command. This is intended for a local Codex instance or wrapper script.

The app remains read-only. The local agent receives a grounded inventory snapshot and returns either:

- `respond`: send this WhatsApp response
- `route_to_human`: the app should treat the case as needing human help; if `responseText` is present, it may send that short acknowledgement to avoid leaving the customer with no reply

## Enable CLI Mode

```text
AGENT_DECISION_MODE=local_cli
AGENT_LOCAL_CLI_COMMAND=<your command>
AGENT_LOCAL_CLI_TIMEOUT_MS=120000
```

For local contract testing:

```text
AGENT_DECISION_MODE=local_cli
AGENT_LOCAL_CLI_COMMAND=npm run -s agent:mock
```

To route through the installed local Codex CLI:

```text
AGENT_DECISION_MODE=local_cli
AGENT_LOCAL_CLI_COMMAND=npm run -s agent:codex
AGENT_LOCAL_CLI_TIMEOUT_MS=120000
AGENT_PROMPT_PATH=prompts/local-codex-agent.md
```

If the bundled Codex binary is not auto-detected, set `CODEX_CLI_PATH` to the absolute `codex.exe` path.

Tune behavior in `prompts/local-codex-agent.md`. Keep that prompt focused on response policy, grounding, disclosure, and handoff behavior.

## Input

The command receives one JSON object on stdin with:

- `message`: normalized inbound WhatsApp message
- `conversation`: 24-hour rolling context for the sender, including recent inbound/outbound turns and disclosure state
- `extracted`: product, quantity, package size, department, and city signals
- `catalog`: read-only product and variant snapshot
- `inventoryMatches`: deterministic requested/alternative/upsell matches when available
- `deliveryGuidance`: delivery calculator object when available, including missing-field flags or grounded price/ETA values

The local agent should only recommend products and variants present in `catalog`, `inventoryMatches`, or `deliveryGuidance`.

`conversation.turns` exists to interpret short follow-ups, such as a customer replying `Bogota` after the bot asked for delivery location. It is not a source for inventory, prices, or delivery promises.

## Output

The command must print exactly one JSON object to stdout:

```json
{
  "action": "respond",
  "responseText": "Para Riko Malt 500Ml Venezuela, tenemos estas presentaciones: botella 500ml, 500ml x 3 unidades.",
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
For delivery questions, use only deliveryGuidance. Ask for department and city/municipio when missing.
Decide whether to respond or route_to_human.
Return only valid JSON matching the AgentDecision schema.
Prefer a useful grounded attempt when a known product is detected.
Route to human when the request is outside inventory/delivery guidance or cannot be answered from the provided data.
```

Keep stdout clean. Logs or commentary should go to stderr.
