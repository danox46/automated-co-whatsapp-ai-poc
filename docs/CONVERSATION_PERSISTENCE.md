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

## MCP response and logging inventory

Connected agents can receive only the fields declared by the tool output
schemas. Conversation summaries contain an opaque conversation reference,
optional display name, activity and service-window timestamps, message/unread
counts, opt-out and automation-pause flags, and a policy revision. History rows
contain opaque message and conversation references, direction, normalized kind,
optional bounded text or template name, occurrence time, and delivery status.
The connection and policy tools return configuration/status metadata only.

They never return provider account or participant identifiers, access or refresh
tokens, signing material, raw webhook bodies, arbitrary provider JSON, media
bytes, or media URLs. The production logging contract is metadata-only: event
type, tenant-safe correlation reference, timestamp, duration, outcome code, and
policy revision. Credentials, authorization headers, phone numbers, display
names, message/template content, tool arguments, and raw provider errors must be
redacted or omitted. The current MCP/Worker path does not persist request or
response bodies in logs.

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

Each tenant Durable Object stores its own bounded retention configuration and
schedules one recurring alarm. The local defaults and maximum disclosed periods
are:

- normalized message content and events: 90 days;
- inactive conversation metadata: 365 days;
- unmatched delivery-status events: 7 days; and
- retention run interval: 24 hours.

The cutoff comparison is strict: a record exactly on the cutoff remains until
the next run. After message pruning, message and unread-inbound counts are
recomputed from retained rows. Empty inactive conversations are deleted after
365 days unless they carry an opt-out or active human-handoff pause. This keeps
the minimum enforcement state needed to avoid contacting someone against their
choice while removing ordinary inactive conversation data.

The trusted application has internal RPC controllers for deleting one exact
conversation or all conversation data in a tenant. Those destructive methods
are deliberately absent from the connected-agent MCP tool registry and must be
called only by a separately authenticated, auditable administrative workflow.
Deleting all conversation data preserves the immutable tenant binding and the
retention configuration so a Durable Object cannot be reassigned accidentally.

`wrangler.mcp.jsonc` contains non-secret retention values. Deployments may
reduce them within the validated bounds; increasing them beyond the documented
limits requires an explicit product/privacy review and matching disclosure.
Provider connection credentials and backups remain separate systems and must
have their own deletion verification before production activation.
