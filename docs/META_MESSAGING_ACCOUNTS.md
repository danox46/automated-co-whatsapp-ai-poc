# Existing-phone integration onboarding

Meta's H2 2026 account model separates the phone identity from Messaging Accounts.
The legacy `waba_id` field identifies a Messaging Account, which holds templates,
billing and webhook subscriptions. Multiple Messaging Accounts can share one phone
number. The WhatsApp Account ID is not exposed until the next rollout phase;
never derive it from a phone or Messaging Account ID.

Primary references checked 26 October 2026:

- https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution/onboarding/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution/messaging/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/app-only-install/

## Two distinct operations

Same-account credential renewal uses the existing reauthorization invitation. It
pins the current Messaging Account, phone and credential revision, then conditionally
updates that installation. See `META_REAUTHORIZATION.md`.

A separate integration on an existing Cloud API phone uses a normal fresh-tenant
invitation with `onboarding: { flow: "existing_account" }`. It uses the documented
app-only SDK flow. Its client accepts the documented phone-bound completion types
`FINISH_GRANT_ONLY_API_ACCESS` and `FINISH`; the latter is a compatibility path
for the updated account model, not a claim that a specific live callback used it.
Neither event grants access by itself: the backend requires the invitation/state,
exact optional asset pins, actual exchanged token and verified phone membership. The selected
Messaging Account is bound to the new tenant after real provider verification;
the original installation, routes, grants and history are retained. This is not
WhatsApp Business app coexistence onboarding and does not register a new number.

Admins may additionally set `expectedAssets: { wabaId, phoneNumberId }` inside
`onboarding` when the exact integration assets are already known. The callback
rejects a mismatch before exchanging the one-time code. Those pins remain
server-side. Without pins, consent determines the assets and the provider must
still verify that the phone belongs to the selected Messaging Account. The
one-Messaging-Account/one-tenant guard remains in force in both cases.

`existing-invite <origin> <fresh-tenant> <label> [<ma-id> <phone-id>]` creates a
24-hour client invitation. `existing-reinvite` explicitly rotates that tenant's
unused pending invitation, retaining the cohort seat and invalidating its old
token. Original attempt evidence must be retained separately; never replay an
old Meta authorization code after rotating. Ordinary new-number onboarding and
same-Messaging-Account renewal remain separate paths.

Billing and templates are separate per Messaging Account. A saved card on another
account is not payment readiness for the new one. Outbound dispatch continues
to source `paid_messaging_account_id` from the authenticated installation, not
agent input. Do not change the running bot's account mapping to make a new
integration test pass. Do not enable a second auto-reply runtime on the same
phone during onboarding acceptance.

Unit tests exercise callback membership checks, exact pins, wrong-flow rejection,
consumed-code handling and old-installation preservation. Actual Workerd SQL/RPC
tests exercise persistence, rotation, same-phone/distinct-account routing and
history/session isolation. These are synthetic supporting evidence. Completion
requires a real Meta callback, actual asset/subscription readback and scoped MCP
access on the new installation. Genuine account-update receipt is checked
separately. App Review submission and publishing remain separately held.

The page distinguishes authorization-returned from account-details-returned states.
Phone-less, malformed and mismatched-flow completions show explicit explanations,
without logging payloads, codes or tokens. There is no automatic code replay or
resubmission. A provider Done screen alone is not MCP connection proof.
