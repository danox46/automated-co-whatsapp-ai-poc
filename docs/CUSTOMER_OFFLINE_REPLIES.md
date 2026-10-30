# Customer offline replies

The connected native inbox reports its saved fallback text and activation state to
`POST /native/runtime` using its existing OAuth send grant. The authenticated
principal selects the tenant; the body contains only `revision`, `enabled` and
`offlineMessage`. Reports are bound to the connected installation and reject
older or conflicting settings. Unchanged presence is persisted at most once a
minute. A runtime is considered offline after 90 seconds.

A verified inbound callback stores a pending check. If the runtime is already
offline, it attempts the configured reply immediately; otherwise a Durable Object
alarm checks after the presence interval. The queue survives eviction and shares
the tenant alarm with retention. It removes answered, opted-out, human-owned,
expired, paused and disconnected work. Pausing clears pending checks, including
before subsequent reactivation. Reconnecting an installation invalidates its old
configuration binding.

Replies reuse the existing service-window, content, provider-installation and
atomic outbound-reservation checks. The reservation also checks the current
runtime generation and inbound timestamp, preventing a reply after reconnection
or a competing answer. One stable key per outage, conversation and settings
revision prevents repeated fallback replies. An uncertain provider result retains
its reservation and a sanitized diagnostic rather than automatically replaying.
The fallback configuration remains durable when the native application closes;
its OAuth bearer token is never stored with that configuration.

## Development evidence, 2026-10-30

- Endpoint and pending-queue failures reproduced before implementation; pause
  regression reproduced and repaired.
- `npm run verify`: typecheck, 288 unit tests and build passed.
- Worker suite: 76 tests passed. After preserving the existing retention scheduling
  contract, 16 affected Worker tests passed again.
- Actual Durable Objects exercise signed callbacks, tenant/installation binding,
  concurrent duplicates, uncertain sends, eviction/restart, delayed alarms,
  reconnect, prior answer, pause, human takeover and retention coexistence.
- Synthetic Graph transport only; no external WhatsApp message or deployment.

The customer's configured working-hours guidance remains unchanged. Real Meta
onboarding and the complete Premium service-capacity path require separate
end-to-end acceptance before publication.
