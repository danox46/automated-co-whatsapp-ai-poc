# WhatsApp MCP policy boundary

This repository now contains an actual Streamable HTTP MCP handler for the WhatsApp lane. The handler is intentionally fail-closed and is not deployed yet.

## Registered tools

- `whatsapp_get_policy`: returns the public policy version and policy URLs.
- `whatsapp_get_connection_status`: returns sanitized readiness only.
- `whatsapp_evaluate_action`: evaluates policy without performing the action.

There is no send, template mutation, webhook mutation, export, or deletion tool. Unknown tool names and path-like aliases are rejected. Every listed write action evaluates to denied.

## Authorization boundary

- The endpoint accepts access tokens only in the `Authorization: Bearer` header.
- The protected resource publishes OAuth discovery metadata at `/.well-known/oauth-protected-resource`.
- Tokens in URLs are rejected.
- The verifier must validate the MCP server audience and the exact read scopes.
- The production worker uses a deny-all verifier until the OAuth broker supplies an audience-bound verifier.
- Provider tokens are separate from MCP tokens and may not be passed through.

## WhatsApp rules enforced before any future write tool can be registered

1. Recipient supplied the number and opted in for the exact purpose/category.
2. No active opt-out, block, suppression, or legal hold.
3. Free-form reply is within the current user-initiated service window; otherwise the exact approved template and consented category are required.
4. Sender, tenant, purpose, template variables, frequency, and destination are server-side facts, not caller assertions.
5. Content is not illegal, deceptive, discriminatory, harassing, spam, a prohibited vertical, or an attempt to evade platform controls.
6. The message does not request or disclose full payment-card, financial-account, government-ID, medical, or similarly sensitive identifiers.
7. A prompt and direct human escalation path exists; automation pauses on handoff.
8. The final action is rate-limited, idempotent, audited without raw credentials, and subject to explicit owner confirmation.

The current release deliberately stops before item 8: no write tool is registered.
