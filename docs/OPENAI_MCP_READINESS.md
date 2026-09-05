# OpenAI MCP technical readiness

This is the local engineering contract for a future public OpenAI plugin. It
does not authorize deployment, public submission, production messaging, or a
legal-policy review.

## Locally implemented

- Streamable HTTP MCP handler at `/mcp`.
- Stable action-oriented tool names and focused descriptions.
- Strict input schemas and explicit output schemas for every tool.
- Structured content plus concise text content for every successful result.
- Explicit `readOnlyHint`, `openWorldHint`, and `destructiveHint` values.
- Messaging tools marked as external, state-changing, and irreversible.
- Per-tool OAuth scope metadata and actionable `mcp/www_authenticate` errors.
- Protected-resource metadata with documentation, privacy, and terms links.
- Header-only bearer tokens; query-string tokens are rejected.
- Audience checking and tool-level scope checking.
- Server instructions that prevent invented recipient, consent, timing, sender,
  or template facts.
- Contract tests for tool lists, annotations, output schemas, OAuth metadata,
  authentication challenges, scope failures, and representative policy paths.
- Tenant-scoped `whatsapp_list_conversations` and
  `whatsapp_get_conversation_history` tools with bounded opaque pagination and
  structured results that exclude raw provider payloads and provider IDs.
- A local SQLite-backed Durable Object schema that deduplicates messages,
  reconciles out-of-order delivery statuses, stores enforcement state, and is
  sharded one object per authenticated tenant.
- Signed Meta webhook normalization into bounded message records; internal
  ingestion and policy-state mutation are not exposed as MCP tools.

## Durable state boundary

OpenAI does not require durable conversation state merely because an endpoint
uses MCP. Persistence is needed only when a tool's real guarantees depend on
facts that must survive restarts or concurrent calls. A future WhatsApp send
path has that requirement because it must enforce:

- canonical tenant, WhatsApp account, sender, and conversation binding;
- last verified user-inbound timestamp;
- opt-out, suppression, automation-pause, and human-handoff state;
- consented template categories and exact purposes;
- currently approved and enabled template metadata;
- policy revision and consumed idempotency keys; and
- provider message IDs and delivery-status reconciliation.

The MCP endpoint, OAuth logic, policy engine, provider adapter, and durable
store may be implemented in the same service and repository. The boundary is
about responsibility, not process or deployment topology. Immediately before
calling Meta, the send path must re-read authoritative state and atomically
reserve the idempotency key. For free-form replies it must also reject the
reservation when the supplied `notAfter` deadline has passed. Only then is
`idempotentHint: true` a truthful runtime guarantee.

## Remaining before deployment

- Implement authorization-server discovery, authorization-code flow with PKCE
  S256, supported client registration, issuer identification, resource
  propagation, refresh/revocation handling, and production token verification.
- Bind every authenticated subject to an allowed tenant and Meta installation.
- Extend the implemented conversation store with consent/template registries,
  durable idempotency reservations, and the Meta Cloud API send adapter.
- Add bounded timeouts, rate limits, retry/backoff rules, duplicate suppression,
  circuit breaking, and provider error translation.
- Add sanitized metrics and audit events for initialization, authentication,
  tool latency, policy blocks, provider failures, and delivery reconciliation.
  Never log credentials, bearer tokens, phone numbers, or message bodies.
- Assign production secrets and a permanent HTTPS origin to the prepared
  `wrangler.mcp.jsonc` Worker configuration.
- Validate the production endpoint with MCP Inspector and ChatGPT developer
  mode, including expired tokens, wrong issuer/audience, missing scopes,
  cross-tenant references, duplicate calls, boundary timing, concurrent sends,
  and provider timeouts.
- Re-scan final deployed metadata and prepare reviewer credentials that do not
  require MFA or private-network access.

## Release discipline

Treat names, schemas, annotations, security metadata, and server instructions
as a versioned public contract. Prefer backward-compatible additions. A tool
that cannot meet its advertised guarantees must remain unregistered rather
than exposing a degraded or misleading implementation.
