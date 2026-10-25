# Government data requests · Morning Meta integrations

Version 1.0 · prepared 2026-10-25 UTC (2026-10-24 Bogotá).
Owner: Daniel Rosales, MORNING ARP S.A.S.

This is the prospective operating procedure prepared at Daniel's request. It
does not certify historical conduct, replace advice on a particular legal
request, or authorize an agent to disclose data. Do not backdate it or describe
it as a long-standing practice. Daniel owns adoption and oversight; until he
reviews it, treat it as a prepared procedure, not a completed Meta attestation.

## What is covered

Apply this procedure to every government, law-enforcement, intelligence,
administrative or court request for data Morning holds through its Meta
integration, including national-security requests and preservation demands.
Development and sandbox data are not exempt merely because the app is in test.

Morning can hold account/tenant bindings, recipient mappings, normalized
conversation text, supported images, timestamps, delivery/policy state and
connection records. The current retention implementation is described in
`CONVERSATION_PERSISTENCE.md`; do not promise data that was never captured or
has already expired. Provider credentials and signing keys are not ordinary
response content. Meta, Cloudflare and customer-chosen clients separately
control data they hold; do not promise to produce or delete their records.

There is no automated government-disclosure endpoint, standing bulk export,
special access account or backdoor. A support message is not legal authority.

## 1. Intake and legality review

1. Route a request received through support or any other channel to Daniel.
   Do not confirm an account exists, open supplied attachments in a privileged
   environment, disclose data or acknowledge a legal conclusion automatically.
2. Preserve the original request in protected, case-specific storage outside
   Git and general ARP resources. Record arrival time and the asserted deadline.
   Check a deadline promptly; do not invent a standard response period.
3. Verify the requesting agency and official through an independently obtained
   official contact, not just a message's display name, phone or reply address.
4. Check the signed instrument, legal authority, jurisdiction, service,
   purpose, requested subjects/data/time range, necessity and proportionality,
   and any notification or preservation restriction. A claim of urgency or
   national security does not establish validity by itself.
5. Obtain qualified legal advice where validity, jurisdiction, a secrecy order,
   cross-border disclosure, emergency disclosure or the available challenge is
   uncertain. Do not use this document as a conclusion that all requests require
   a court order: Colombian law also recognizes certain requests made by public
   or administrative entities within their lawful functions.

## 2. Clarification, refusal and challenge

Do not comply with a request merely because it looks official. Ask for the
missing legal basis, correct service, narrower identifiers or time range when
the request is deficient or overbroad. Reject, narrow or challenge an unlawful
request, including using counsel and an available formal challenge where
appropriate. Record the defect, action, deadlines and reason for the decision.
Do not promise that litigation is always required, possible or successful.
Preserve the ability to challenge before the response deadline where possible.

## 3. Preservation and minimum disclosure

- Preservation is not disclosure. Preserve only relevant existing data when a
  verified legal obligation requires it. Record its scope, basis and expiry.
- The current Worker does not implement a general legal-hold switch. Daniel must
  arrange a bounded protected export or a reviewed implementation before normal
  retention removes required records. Do not silently edit the operational store,
  suspend all cleanup, or claim a hold exists without a verified preservation
  receipt. Escalate immediately if preservation cannot be completed in time.
- Once legal validity and scope are resolved, create the narrowest responsive
  dataset: correct tenant, exact subjects/period/fields, and only records actually
  held. Exclude unrelated conversations, images, tenant data and credentials.
  Review redactions and note absent or expired data rather than reconstructing it.
- Daniel must approve the exact recipient and response after the legality review.
  An agent may prepare a private candidate but cannot infer authority to send it.
- Verify the recipient and use an appropriate protected delivery channel. Keep
  a manifest/hash of what was actually sent and delivery evidence in the case.
- Evaluate legally permitted notice to affected businesses/users with counsel;
  do not notify contrary to a valid restriction or promise universal notice.
- Do not add interception, weaken encryption or create standing access as a
  response to an ordinary data request. Escalate any such demand for legal and
  security review, separately from an export of existing records.

## 4. Request and response register

Use `GOVERNMENT_DATA_REQUEST_CASE_TEMPLATE.md` for each actual request. Retain
the request, independent identity verification, legal reasoning, reviewers,
decision, response scope, exact material disclosed (if any), recipient,
timestamps, challenges, notice decision and preservation/closure evidence.
Apply a documented case-specific retention decision; no indefinite blanket
retention is created by this procedure.

Keep raw legal material, identities and disclosed datasets in restricted case
storage, not Git or general dashboards. ARP may hold only a sanitized case ID,
owner, state, due date, decision summary and protected evidence reference. A
restricted legal matter must not be promoted to a general operational audience.

For a Meta questionnaire, distinguish requests from actual disclosures and
follow its exact reporting period and counting rule. Do not count API calls,
messages or generated test data as people whose data was disclosed. Reconcile
distinct affected users and unresolved scope with Daniel before attesting.

## 5. Review and exercise

Before asserting these processes are in place, Daniel should review the
procedure and record adoption, the restricted evidence location and an intake
owner. Exercise an overbroad synthetic request without accessing or disclosing
real user data: record identity/legality checks, narrowing/challenge decision,
minimum-data selection and a blank-response manifest. Label the exercise as
synthetic; it is not a historical government request or actual disclosure.

Revisit after a real case, provider/retention changes, new jurisdictions or a
material change in law. This procedure does not establish that any request was
received, challenged, fulfilled or rejected before its creation.

## Sources consulted

- Meta's actual App Review Data handling questionnaire: legality review,
  challenge of unlawful requests, data minimization and request/response records.
- Colombian Ley 1581 de 2012, especially articles 4, 10 and 13:
  <https://www1.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981>
- SIC explanation of requests made within a public authority's legal functions:
  <https://sedeelectronica.sic.gov.co/publicaciones/boletin-juridico/boletin/cuando-una-informacion-es-requerida-por-una-entidad-publica-o-administrativa-en-ejercicio-de-sus-funciones>

Meta's own law-enforcement response practices are useful context, not a legal
basis for Morning's disclosures and not a substitute for Morning's assessment.
