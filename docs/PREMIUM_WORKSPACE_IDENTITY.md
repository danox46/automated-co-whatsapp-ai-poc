# Premium WhatsApp workspace identity

Development contract, not enabled on the hosted service.

A customer OAuth request carries `workspace_id` alongside its ordinary registered
client, redirect, resource, scope and PKCE fields. The Worker uses the separately
registered `MORNING_CUSTOMER_CLIENT_ID`, with Morning policy `enrolled-owner`
and exact callback `https://<whatsapp-host>/premium/auth/callback`.
`MORNING_ISSUER` remains the authoritative identity origin.

The signed ID token and fresh UserInfo must both contain the selected
`workspace_id` and `workspace_role: owner`. The provider tenant is derived by
`premiumWorkspaceTenant(issuer, workspaceId)`; it never aliases the existing
operator installation. Provisioning must use that same helper. Each workspace
has one WhatsApp installation in this version. Its connected installation is
resolved from the registry and can optionally be pinned by `installation_ref`.
Missing or disconnected installations direct the owner to finish setup.

Customer and operator flows have separate cookies, callback routes and sealed
session namespaces. Existing operator sessions retain their original namespace.
Workspace requests never fall back to a stale Meta pilot browser session.
Changing workspace requires a fresh identity flow. Current UserInfo is checked
before issuing a bot authorization code; revoked ownership or identity sessions
deny access. Existing bot token and messaging policy contracts remain in force.

The registration is host configuration once per integration, not once per owner.
Premium now opens `/premium/whatsapp/setup?workspace_id=<id>`. A verified owner
can begin Meta signup without an operator-created invitation or an existing
installation. The setup session carries an encrypted, stable invitation intent;
repeated clicks resume that intent and one durable cohort reservation. GET is
read-only; POST uses the authenticated owner session, same-origin CSRF form and
server-derived tenant. Completion returns to the workspace connection status.
ARP configures the exact provider origin through `PREMIUM_WHATSAPP_ORIGIN`.

No production environment variable or existing operator mapping was changed.
Native profile generation, selecting its runtime and real provider acceptance
remain unfinished. The existing closed-pilot cohort limit remains in force;
commercial enrollment needs its own entitlement/capacity wiring before launch.
Setup now claims an encrypted invitation intent in the durable identity store,
scoped to issuer/client namespace and workspace. Fresh sign-ins resume that
intent; concurrent requests share it without extending its original expiry.
Ownership is revalidated before each attempt. An older invitation created before
this change can be adopted by its original session; a new session cannot recover
its raw token from the invitation hash and must wait for that legacy invite to expire.

Verification, 2026-10-28:
- Regression: 4 failing identity tests and a real Worker pilot-cookie fallback
  failure were reproduced before the changes.
- `npm run verify`: typecheck, 282 tests and build passed.
- `npm run test:workers`: 61 real Worker/SQLite/RPC tests passed.
- Companion ARP evaluator `experiments/premium-tenant/verify-whatsapp-identity.mjs`
  exercised both actual implementations over loopback HTTP with two synthetic
  verified identities, provider installation fixtures, restart, cross-workspace
  reauthorization, revocation and disconnection. It passed after adding the
  explicit customer callback to the ARP registration contract.
- This does not prove Google login, Meta onboarding or delivery of a message.

Customer setup verification, 2026-10-28:
- Two setup tests failed before implementation; concurrency regression failed
  before idempotent invitation/seat handling; unavailable configuration returned
  404 before adding its explicit 503 response. Earlier logs retained locally.
- Final `npm run verify`: typecheck, 285 tests and build passed.
- Final `npm run test:workers`: 63 tests passed. Real Worker route and SQLite/RPC
  test opened setup, reused one invitation, rendered the Meta page and rejected
  another workspace. The expected conflict test emits an exception diagnostic.
- Meta signup tests use a fake Graph client, including customer completion redirect.
- Companion ARP evaluator now verifies two empty owners through the real issuer
  and consumer. Identities, provider state and invitation creation are synthetic.
- No messages sent, Meta grants created, or production deployment performed.


Native connection export (development): a connected owner's setup page offers
`format=connection` when the registered native callback is configured. The file
contains version/kind, label, MCP origin, workspace ID, opaque installation
reference and exact callback. It contains no provider/session tokens or local
paths. Current ownership and connected-installation reference are checked on
export. An unconnected workspace returns 409; unavailable native setup returns
503. Reopening native enrollment carries both workspace and installation.

The native branch consumes this file directly through `meta:connect`; it derives
its own protected OAuth path under the current user's installation state. Full
business runtime preparation/agent selection remains separate from this grant.

Cross-session setup recovery verification, 2026-10-29 UTC:
- Real Worker regression reproduced HTTP 409 on a fresh login before the repair.
- `npm run verify`: typecheck, 286 unit tests and build passed.
- `npm run test:workers`: 64 tests passed, including concurrent setup claims,
  separate workspace keys, original expiry, invalid lifetime rejection and a fresh
  browser session resuming the original registry invitation.
- Local failure and passing logs retained as `artifacts-premium-setup-resume-*`.
- Development only; real Meta signup and message acceptance remain outstanding.
