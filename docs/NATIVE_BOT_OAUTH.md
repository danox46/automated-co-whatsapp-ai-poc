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

## Source-only acceptance and outstanding identity work

The optional callback is not enabled in the deployed configuration. Do not turn
it on merely because protocol tests pass. The existing authorization session
comes from the browser that completed Meta Embedded Signup. A client doing
signup remotely does not give the bot host that browser cookie.

The assisted hosted-pilot path therefore needs the existing first-party
Morning OIDC pattern, with a WhatsApp-specific client registration and an
authorized operator-to-installation mapping. Confío's host browser sessions
provide the source pattern; its registration/secret/owner mapping must not be
copied blindly or treated as blanket client authority. Preserve the existing
Meta pilot and OAuth paths while adding the intended Morning identity path.
Never copy a client's cookie, browser profile, native login or keyring state to
the operator host, and never map every signed-in visitor to the owner.

Synthetic tests have exercised actual native SDK discovery, PKCE code exchange,
issuer/state checks, signed access-token verification, refresh rotation and
installation validation against the backend authorization core. Separate local
HTTP callback tests cover wrong state/issuer/host, cancellation and expiry.
These do not prove a real Morning login, a client Meta signup or client intake.
App Review, customer-assets acceptance, bot activation and publication holds
remain separate. Existing serving code/configuration is unchanged.
