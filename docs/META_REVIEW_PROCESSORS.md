# Meta review processor register

Prepared 25 October 2026 (America/Bogota). This records the public-source draft
basis, not a submitted attestation or a residency guarantee. Daniel directed
using applicable public vendor information; a custom vendor reply is not a
prerequisite. Both prepared vendor emails remain unsent and held.

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
country/territory codes. The draft combines the possible global edge footprint
with published developer-platform and support geography, including the EEA.
Mainland China Network is a separate service and is not enabled for this Workers
deployment; it is excluded, while Hong Kong and Macao remain separate listed
network locations. Adding EEA locations absent from the edge-city list gives
134 selected country/territory entries. This is a conservative possible
footprint, not a claim that every record visits every location.

For our Colombian consumer account, the applicable geographic privacy-policy
reference is the rest-of-world policy, not the U.S.-resident policy. It says
processing can occur in the U.S. and other vendor/affiliate territories. The
Business/API subprocessor list supplies 29 explicitly enumerated infrastructure
and support countries as broader public company geography for the draft.
The reviewer note explicitly identifies the table's product scope. It is not
presented as the consumer contract or a consumer-only exhaustive routing
guarantee; its retention, training and regional controls are not inferred for
our subscription.

Both entries are saved in Meta with the IT/cloud-storage-and-processing service
category. Independent reopening reads back Cloudflare 134 entries and OpenAI
29 entries. Meta's required-field validation marks Data handling 100%; this is
draft completeness, not provider approval or a final owner attestation. The
reviewer instructions retain the public sources and the product-scope/location
qualifications. Source/code lists and readback evidence stay in protected
operator evidence, not in public credentials or internal-dashboard links.
No residency purchase or new customer restriction is required by this work.

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
