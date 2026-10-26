# Reauthorize an existing WhatsApp connection

Use Meta's documented [App-Only Install](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/app-only-install/)
flow to authorize an already registered Cloud API account. This is distinct
from adding a phone number, migrating a phone, or Business-app coexistence.

The existing protected admin CLI provides:

```text
reauthorize-invite <https-origin> <existing-tenant-id> <label>
```

The corresponding POST route is
`/admin/pilot/installations/:tenant/reauthorization-invitations`. Only the admin
can issue it, only for a connected installation, with a one-use invitation
lasting at most 24 hours. It does not reserve another cohort seat. The access
link belongs in protected local storage and must not enter Git or ARP records.

The server pins the original tenant, WABA, phone and encrypted credential nonce.
The browser receives only the flow selection; it cannot choose these server
bindings. The callback verifies the exact same assets before exchanging the
one-use code and verifies the phone with the new Meta token before persisting
it. A conditional SQL update accepts the old credential nonce only once, so a
stale or concurrent authorization cannot replace a newer credential. The nonce
is revision metadata, not a decrypted credential.

This invitation uses Meta's explicitly documented app-only launch parameters:
`extras.version: v3`, `features: [{name: app_only_install}]` and the matching
`FINISH_GRANT_ONLY_API_ACCESS` completion event. Ordinary new-business onboarding
keeps its existing v4 configuration. Do not claim undocumented v4 app-only
compatibility from the v3 guide. A real provider-screen/callback check is still
required after source tests pass.

The current installation reference, original connection date, history,
business profile and existing MCP grants remain in place. An existing app
subscription is reused. Failed, expired, mismatched or superseded attempts do
not deliberately disconnect the account or replace its working credential.
Uncertain outcomes require original-operation reconciliation before another
attempt. A definite expired/replaced browser session is identified separately
and asks for a fresh page load rather than falsely claiming uncertain writes.

The prior fresh-client validation invitation remains a separate failed/pending
test record. Reauthorizing Morning proves the existing-business authorization
path; it is not evidence that a different company has completed onboarding.
Do not delete/re-register the live number, create another WABA, or reuse El
Portal's running service merely to obtain a clean test result.
