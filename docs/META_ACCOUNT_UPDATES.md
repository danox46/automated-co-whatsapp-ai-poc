# WhatsApp account lifecycle callbacks

`account_update` is required by Meta's [Embedded Signup implementation guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/).
The event shapes come from the [account_update reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update/), checked 26 October 2026.

The existing webhook validates the body size, Meta HMAC signature and WABA
envelope before recording any lifecycle observation. Only known event names,
provider occurrence timestamps and first-received timestamps are retained.
Customer names, owner business IDs, violation details and raw callbacks are not
stored in this journal. Unknown event types are ignored rather than retained
as arbitrary provider text.

For partner asset events, `waba_info.waba_id` identifies the customer's WABA;
the envelope's `entry.id` can identify a partner portfolio. App installation
and uninstallation events must name this app. Certification and other direct
WABA events use the documented entry identifier. Mixed envelopes exclude
lifecycle-only portfolio entries from conversation routing.

Diagnostics are keyed by WABA in its existing Durable Object, including when
an event precedes the completed signup callback. They do not create an
installation, authorize a tenant, revoke access or automatically disconnect a
business. A delayed announcement is evidence to reconcile, not authority to
overwrite the current installation.

The journal deduplicates event name plus provider timestamp, preserves the
first receipt time, retains at most 50 records and expires records after 90
days from receipt. Durable Object alarms enforce expiry even without future
reads. Read/write paths also prune. Installation deletion clears diagnostics
only if the WABA is unbound or still belongs to that installation; stale
cleanup cannot erase a replacement owner's journal.

The existing authenticated operator installation-status endpoint includes
`accountUpdates`. The data contains event names/times only. Connected-agent MCP
tools, scopes, message history and policy enforcement are unchanged. A storage
failure returns 503 so Meta can retry; duplicate callbacks are safe.

## Acceptance boundary

Worker tests exercise genuine signature verification, Durable Object SQL/RPC,
alarm execution, operator access checks and mixed message/lifecycle ingestion
using synthetic principals and payloads. They do not prove Meta subscription
or a real provider event. Activate `account_update` alongside the existing
`messages` subscription only through the approved provider setup, then verify
a genuine event separately. Never inject a synthetic callback into the live
provider inbox to manufacture that evidence.
