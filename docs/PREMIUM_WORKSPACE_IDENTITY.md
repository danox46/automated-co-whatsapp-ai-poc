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
There is no customer provider enrollment endpoint yet: the Premium setup flow,
Meta signup and native profile generation still need to be connected. No
production environment variable or existing operator mapping was changed.

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
