# WhatsApp MCP policy boundary

This repository contains a Streamable HTTP MCP handler for the WhatsApp lane. It is capability-maximizing and policy-enforced: compliant messaging tools are registered when a server-side Meta provider capability is configured, while the production entry point remains inaccessible until the OAuth verifier and provider dependencies are connected. The MCP handler is not deployed yet.

Every advertised tool declares an output schema plus explicit `readOnlyHint`,
`openWorldHint`, and `destructiveHint` values. Messaging tools are correctly
marked destructive because an external message cannot be unsent, even though
the server applies policy checks before dispatch. Per-tool OAuth scopes are
mirrored in tool metadata for OpenAI clients, and unauthenticated or
under-scoped calls return an actionable `mcp/www_authenticate` challenge.
Write tools advertise `idempotentHint: true` only when the injected provider
capability explicitly guarantees durable deduplication; incomplete adapters and
test doubles must advertise `false`.

## Registered tools

- `whatsapp_get_policy`: returns the public policy version and policy URLs.
- `whatsapp_get_connection_status`: returns sanitized readiness only.
- `whatsapp_evaluate_action`: explains whether an action is read-only, administratively blocked, or requires server-owned runtime policy checks.

When the authenticated Meta messaging capability is configured, the server also registers:

- `whatsapp_reply_to_inbound`: sends a free-form reply only inside the server-verified 24-hour customer-service window.
- `whatsapp_send_template`: starts or reopens a conversation using a server-verified approved template for a recipient-consented category.

Unknown tool names and path-like aliases are rejected. Bulk messaging, template mutation, webhook mutation, export, and deletion remain outside the unattended MCP surface and require dedicated authenticated administrative workflows.

## Authorization boundary

- The endpoint accepts access tokens only in the `Authorization: Bearer` header.
- The protected resource publishes OAuth discovery metadata at `/.well-known/oauth-protected-resource`.
- Tokens in URLs are rejected.
- The verifier must validate the MCP server audience and the exact read scopes.
- Messaging tools additionally require `whatsapp.messages.send`; read-only clients do not need this scope.
- The production worker uses a deny-all verifier until the OAuth broker supplies an audience-bound verifier.
- Provider tokens are separate from MCP tokens and may not be passed through.

## Runtime enforcement for messaging tools

1. Recipient supplied the number and opted in for the exact purpose/category.
2. No active opt-out, block, suppression, or legal hold.
3. Free-form reply is within the current user-initiated service window; otherwise the exact approved template and consented category are required.
4. Sender, tenant, purpose, template variables, frequency, and destination are server-side facts, not caller assertions.
5. Content is not illegal, deceptive, discriminatory, harassing, spam, a prohibited vertical, or an attempt to evade platform controls.
6. The message does not request or disclose full payment-card, financial-account, government-ID, medical, or similarly sensitive identifiers.
7. A prompt and direct human escalation path exists; automation pauses on handoff.
8. Provider dispatch is idempotent, rate-limited, and audited without raw credentials or customer message content.

The MCP resolves recipient, tenant, sender, last verified user-inbound time, opt-out state, human-handoff state, approved templates, and consented categories and purposes on the server. Caller-supplied phone numbers, timestamps, sender identifiers, approval flags, or service-window claims are never authoritative.

Free-form replies are allowed until immediately before 24 hours after the last verified user message. At the exact 24-hour boundary they return an MCP error with code `WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED`, explain that the account is being protected rather than artificially restricted, and direct the caller to `whatsapp_send_template` or a new customer message. The dispatcher re-resolves the canonical conversation and checks the policy again after content review. The provider adapter must atomically recheck the supplied policy revision, idempotency key, and `notAfter` deadline immediately before making the Meta HTTP request.

Approved templates remain available outside the 24-hour window when the server confirms the template is enabled and the recipient consented to both its category and exact purpose. The MCP never silently converts free-form text into a template.

The provider capability is dependency-injected and absent from the current production entry point. Consequently, no write tools are exposed until durable conversation state, consent/template registries, content validation, idempotent provider dispatch, and OAuth tenant binding are connected.

Durable conversation state is not an MCP protocol requirement and is not
needed by the policy, status, or action-evaluation tools. It is required only
by a provider-backed messaging integration: the send boundary must still know
the last verified inbound-message time, opt-out/handoff state, consent,
approved templates, policy revision, and consumed idempotency keys after a
restart or concurrent request. Keep that state in the messaging capability,
not in the generic MCP transport.

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
The webhook has no provider-token binding or outbound messaging code. The MCP
production entry point remains inaccessible until its OAuth verifier and the
server-side Meta messaging capability are implemented.

`META_WEBHOOK_VERIFY_TOKEN` and `META_APP_SECRET` are declared as required
Worker secrets. Their values must never appear in source, `.dev.vars`, dashboard
state, command output, or test fixtures.
