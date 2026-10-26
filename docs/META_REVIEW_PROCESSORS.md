# Meta review processor register

Prepared 25 October 2026 (America/Bogota). This is the evidence and unresolved
mapping for the draft, not a submitted attestation or a residency guarantee.

## Current direct processing

| Entity | Actual use | Data boundary | Country evidence |
| --- | --- | --- | --- |
| MORNING ARP S.A.S. | Controller and operator | Authorized local processing, encrypted host state and support | Colombia; this is the controller location, not a substitute for vendor locations. |
| Cloudflare, Inc. | Workers backend, SQLite Durable Objects, webhook and OAuth processing | Tenant/account mappings, signed messages, normalized conversation state and encrypted credentials | Global delivery and support; the source does not pin a jurisdiction. U.S. headquarters alone is insufficient. |
| OpenAI OpCo, LLC | Morning's configured Codex bot and agent clients | Conversation context and tool results supplied to the model; provider credentials stay outside model inputs | Consumer services policy describes U.S. and other vendor/affiliate territories. No country-only residency selection has been proved for this subscription. |

Evidence checked: `wrangler.mcp.jsonc`, the Durable Object creation paths and
`src/meta/pilotOnboarding.ts` at backend commit c15b507; the actual native bot
source `src/sol/cliRunner.ts` and `src/sol/dispatcher.ts` in client development
commit df64c62. The CLI uses native login and forwards bounded business/context
to Codex. No API-only processing contract is established by those source files.
The current signed-in runtime and account settings must still govern any
account-specific policy assertion.

Google identity login is not itself evidence that Google receives WhatsApp
message content. Legacy Twilio and optional inventory providers are not added
to this current Meta path merely because adapters exist in the repositories.
Reassess the register if an actual installation enables another processor.

## Published geography and its limits

Cloudflare's service list identifies support affiliates in the United Kingdom,
Singapore, Australia, Germany, Portugal, France, Japan, Canada, Netherlands,
United Arab Emirates, India, United States, South Korea, Mexico, Malaysia,
Sweden and Switzerland. Developer-platform subcontractor locations also
include the EEA. These are published potential processing/support locations;
they do not establish the actual location of this application's records.
Edge execution must be considered separately from affiliate headquarters.

The public network page currently lists 348 cities across 133 distinct
country/territory codes. That marketing coverage is not an attested list of
countries processing this tenant. In particular, China Network is a separate
service; do not silently include or exclude territories without checking the
applicable product. A complete network list is not a replacement for the
processing disclosure.

For our Colombian consumer account, the applicable geographic privacy-policy
reference is the rest-of-world policy, not the U.S.-resident policy. It says
processing can occur in the U.S. and other vendor/affiliate territories. The
Business/API subprocessor list cannot by itself establish the consumer
subscription's exhaustive countries, retention or training controls.

Meta's form requires countries including remote access. The complete
country selections are therefore **not yet certified or saved**. Do not label
the draft complete with a headquarters-only list. This missing disclosure does
not itself require buying a residency product, changing the working runtime,
or imposing a new customer restriction. Resolve the vendor-to-form mapping,
then save and independently read back the actual entries.

## Reviewer access

Meta's current submission guide says reviewers test the app using their own
test accounts and must be able to access it. The Tech Provider recording
alternatives do not waive that requirement.

The current public entry uses a one-time pilot invitation (generic maximum
72 hours; app-owned sandbox maximum 24 hours). It is not a lasting reviewer
login. A separate reviewer must not inherit Morning's tenant, conversation
history, provider token or personal Google session. Do not lengthen ordinary
invitations, silently assign owner identity, or issue a new access credential
merely to clear a form badge. Prepare an explicit reviewer enrollment and
re-entry path using the same tenant/OAuth boundary before declaring access
accepted. Synthetic protocol fixtures and an operator's native login remain
different evidence from a reviewer completing that path.

## Primary references (checked 25 October 2026)

- [Cloudflare service subprocessors](https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/)
- [Cloudflare global processing](https://www.cloudflare.com/trust-hub/gdpr/)
- [Cloudflare network](https://www.cloudflare.com/network/)
- [Separate China Network](https://developers.cloudflare.com/china-network/)
- [OpenAI rest-of-world consumer policy](https://openai.com/policies/row-privacy-policy/)
- [OpenAI Business subprocessor list](https://openai.com/policies/sub-processor-list/)
- [Meta submission guide](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide)
- [Meta Tech Provider guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)

Keep internal dashboard URLs, account credentials and host-state paths out of
public disclosure pages and reviewer instructions. Final video attachment,
usage agreements and App Review submission remain under the owner's existing
hold.
