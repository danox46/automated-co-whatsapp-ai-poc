# Conversation persistence

This local implementation co-locates signed Meta webhook ingestion, durable
conversation storage, and read-only MCP tools. It is not deployed.

## Trust boundaries

The trusted application surface can:

- ingest normalized inbound and outbound messages;
- reconcile delivery statuses that arrive before or after the message record;
- update opt-out, automation-pause, and policy-revision state;
- mark conversations read; and
- prune retained message bodies.

It can also resolve the internal provider binding, last verified inbound time,
opt-out flag, automation-pause flag, and policy revision for an atomic send-path
policy check. That resolver is not registered as an MCP tool.

The connected-agent MCP surface can only:

- list bounded conversation summaries; and
- read a bounded page of normalized history for one opaque conversation
  reference.

The authenticated principal supplies `tenantId`; no conversation tool accepts a
tenant selector. The agent cannot execute SQL, obtain provider account or
recipient identifiers, retrieve raw webhook payloads, mutate history, mark a
conversation read, or override enforcement state.

## Stored data

Each tenant routes to its own SQLite-backed Durable Object. The database stores
opaque public conversation references, internal provider bindings, bounded
message text or template names, timestamps, delivery state, unread counts,
last verified inbound time, opt-out state, automation-pause state, and a policy
revision. Message IDs are unique so webhook retries do not duplicate history.

Raw Meta webhook bodies, access tokens, secrets, media bytes, media URLs, and
unrecognized fields are not stored. Public conversation references are HMAC
derived with `CONVERSATION_REF_SECRET` so phone-number-like provider IDs are not
exposed to MCP clients.

## Local Worker

`wrangler.mcp.jsonc` declares the combined Worker and the
`WhatsAppConversationDurableObject` SQLite migration. Local execution requires
machine-local values for:

- `META_WEBHOOK_VERIFY_TOKEN`
- `META_APP_SECRET`
- `CONVERSATION_REF_SECRET`

`META_TENANT_ID` is a non-secret installation identifier in the local Wrangler
configuration. Replace it with the OAuth-bound installation mapping before a
multi-tenant deployment.

The default Worker intentionally has no token verifier, so tool discovery is
available but every protected invocation fails closed. Inject a production
OAuth verifier before deployment; never add a committed development bypass.

## Retention

The internal writer exposes `pruneMessages(tenantId, occurredBefore)`, but no
automatic deletion alarm is enabled yet. A retention period, scheduled pruning,
authenticated export/deletion workflow, and backup policy must be approved and
implemented before production data is stored.
