# Conversation persistence

The combined Worker co-locates signed Meta webhook ingestion, durable conversation
storage, authenticated MCP tools and policy-enforced provider dispatch. The
existing sandbox deployment was checked on 2026-10-24: fresh provider verification
returned a connected phone and subscribed app. This is not public onboarding
approval or proof of a fresh message cycle.

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

Raw Meta webhook bodies, media URLs and unrecognized fields are not stored in
conversation history. Supported JPEG/PNG inbound image bytes up to 5 MiB are
captured in SQLite attachment chunks, bound to a conversation and attachment
reference. They are deleted when the associated message is pruned or the
conversation is deleted. Encrypted provider credentials live in a separate
installation store, not conversation history. Public conversation references are HMAC
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

History results never return provider account or participant identifiers, access
or refresh tokens, signing material, raw webhook bodies, arbitrary provider JSON
or media URLs. The separate `whatsapp_get_attachment` tool requires
`whatsapp.media.read` and returns supported stored images as native MCP image
content. The production logging contract is metadata-only: event
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

The combined `persistentWorker.ts` entry point wires the OAuth provider and
tenant binding when configured. The separate minimal `worker.ts` entry point
remains deny-all. Never add a development bypass. Source configuration and
`/health` are not substitutes for actual client or provider acceptance.

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
