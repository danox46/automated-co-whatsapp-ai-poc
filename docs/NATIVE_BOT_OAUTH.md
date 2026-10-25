# Native bot OAuth support

`urn:morning:whatsapp-bot` is an optional pre-registered public native client.
It is disabled unless `BOT_OAUTH_REDIRECT_URI` is configured to an exact
`http://127.0.0.1:PORT/callback` URI. No other host, path, credentials, query,
fragment, wildcard or dynamic callback is accepted. The existing ChatGPT client
and redirect are preserved. PKCE S256, issuer/resource binding, issued JWTs,
refresh rotation and revocation use the same authorization server as the MCP.

The owner-admin installation read additionally returns the same opaque
`installationRef` as the authorized MCP connection-status tool, when the
reference secret is configured. An assisted operator can prepare a host profile
without copying raw Meta asset IDs or credentials to the agent. Changing the
tenant/account/phone changes that reference; token refresh does not.

## Source-only Morning identity path

The optional callback is not enabled in the deployed configuration. Do not turn
it on merely because protocol tests pass. The existing authorization session
comes from the browser that completed Meta Embedded Signup. A client doing
signup remotely does not give the bot host that browser cookie.

The assisted hosted-pilot path now implements the existing first-party Morning
OIDC pattern with a separate WhatsApp registration and explicit operator-to-
installation mapping. Its real registration/configuration and intended-user
acceptance are still pending. Confío's registration, grants and signing key
are preserved; its merchant authority is not copied into WhatsApp.
Never copy a client's cookie, browser profile, native login or keyring state to
the operator host, and never map every signed-in visitor to the owner.

Optional managed Worker settings are `MORNING_ISSUER` (the exact Morning HTTPS
origin), `MORNING_CLIENT_ID` (a separately registered public PKCE client), and
`MORNING_OPERATOR_BINDINGS`. The registered callback is this Worker's exact
public origin plus `/auth/callback`, distinct from the native localhost callback.
All existing signing/encryption keys stay in the host's managed secret store.
An illustrative operator binding is:

```json
[
  {
    "subject": "morning:oidc-00000000000000000000000000000000",
    "installations": [
      { "tenantId": "example-installation", "label": "Example business" }
    ]
  }
]
```

These are placeholders, not a real owner assignment. Use the exact existing
Morning subject and independently verified connected installation. Subject and
tenant assignments are trusted host configuration, never query/header defaults.

For the native bot client only, a validated OAuth authorization request starts
Morning sign-in when no Morning browser session exists. Signed issuer, audience,
nonce, PKCE, browser-cookie/state and single-use claims are checked. Only assigned
connected businesses can be selected; one assignment resumes directly. Multiple
assignments use the same-origin CSRF-bound picker. The standard MCP grant still
contains exactly one tenant. An old Meta signup cookie cannot override that
choice. Existing ChatGPT/pilot clients keep their existing session path.

OIDC flow verifiers and delegated identity handles persist encrypted in the
existing OAuth Durable Object, namespaced to origin/issuer/client. Flow lifetime
is five minutes. Browser sessions last at most one hour and no longer than the
Morning delegation; selecting a business never extends expiry. Pending state
is bounded and expired rows are removed during writes. No Google token, ID token
or provider credential appears in pages, operational records or MCP tool output.
Morning UserInfo revalidates the browser identity and membership on authorization
and business selection. It is not called on every bot message. Existing MCP
refresh/revocation remains the normal durable agent grant: Morning logout denies
new browser authorization but does not terminate an already approved bot grant.

Deployment must retain existing managed variables, signing keys and unrelated
clients. Morning's optional `INTEGRATION_LOGIN_ADDITIONAL_CLIENTS` registers this
separate client without replacing its opaque managed base list. Preserve the
active Worker version and a bounded rollback before activation. No deployment
or real-user acceptance is implied by source/protocol checks.

Synthetic tests have exercised actual native SDK discovery, PKCE code exchange,
issuer/state checks, signed access-token verification, refresh rotation and
installation validation against the backend authorization core. Separate local
HTTP callback tests cover wrong state/issuer/host, cancellation and expiry.
The composed synthetic harness also runs actual Morning delegation, explicit
business selection, signed native MCP authorization and the new encrypted client
inbox. These do not prove a real Morning login, client Meta signup or client intake.
App Review, customer-assets acceptance, bot activation and publication holds
remain separate. Existing serving code/configuration is unchanged.
