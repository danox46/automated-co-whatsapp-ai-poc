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

## Meta sandbox webhook

The dedicated Cloudflare sandbox Worker exposes `GET` and `POST`
`/webhooks/meta/whatsapp` for the unpublished Meta sandbox:

- verification succeeds only when Meta supplies the encrypted verification token;
- every event request must carry a valid `X-Hub-Signature-256` generated with
  the Meta app secret;
- request bodies larger than 256 KiB, malformed JSON, and non-WhatsApp Business
  Account envelopes are rejected;
- valid events are acknowledged without storing, logging, forwarding, or
  returning their payloads;
- the webhook cannot send messages and does not change the MCP tool allowlist.

The webhook Worker and the MCP handler are deliberately separate deployments.
The webhook has no provider-token binding or outbound messaging code, while the
MCP production handler remains deny-all until its OAuth verifier is implemented.

`META_WEBHOOK_VERIFY_TOKEN` and `META_APP_SECRET` are declared as required
Worker secrets. Their values must never appear in source, `.dev.vars`, dashboard
state, command output, or test fixtures.
