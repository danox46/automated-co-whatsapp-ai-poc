# Closed-pilot deployment

The pilot runtime is a Cloudflare Worker with three SQLite Durable Object classes:

- `WhatsAppConversationDurableObject` stores tenant-isolated structured history, policy state, retention metadata, and outbound idempotency reservations.
- `WhatsAppPilotInstallationDurableObject` stores one-time invitations, encrypted Meta installations, WABA routing, and the one-internal/three-client cohort ceiling.
- `WhatsAppOAuthStateDurableObject` stores one-time authorization codes, rotating refresh tokens, revocations, and pilot browser sessions.

The Worker remains fail-closed until all provider and OAuth configuration is present. The default module does not expose tenant data without a valid, resource-bound access token.

## Preflight

```text
npm ci
npm run verify:mcp
node ./node_modules/wrangler/bin/wrangler.js types --config wrangler.mcp.jsonc
node ./node_modules/wrangler/bin/wrangler.js deploy --dry-run --config wrangler.mcp.jsonc
```

Use the checked-in Wrangler configuration for non-secret settings. Set `PUBLIC_ORIGIN` to the exact HTTPS Worker origin. The resource identifier, authorization issuer, JWT audience, webhook URL, and ChatGPT MCP URL all use that origin.

## Required Worker configuration

Keep these non-secret values in `wrangler.mcp.jsonc` or the equivalent deployment environment:

```text
PUBLIC_ORIGIN
META_APP_ID
OAUTH_CLIENT_ID
OAUTH_REDIRECT_URI
OAUTH_SIGNING_KEY_ID
```

Store these values as Wrangler secrets:

```text
META_APP_SECRET
META_EMBEDDED_SIGNUP_CONFIG_ID
META_WEBHOOK_VERIFY_TOKEN
CONVERSATION_REF_SECRET
INSTALLATION_ENCRYPTION_KEY
PILOT_ADMIN_TOKEN
OAUTH_SIGNING_PRIVATE_JWK
OAUTH_SIGNING_PUBLIC_JWK
```

Generate independent high-entropy values for the webhook verification token, conversation-reference HMAC key, installation encryption key, pilot administrator token, and OAuth RSA signing key. Do not reuse the Meta App Secret and do not put any value in Git, dashboard HTML, build output, command history, or invitation messages.

The default OpenAI client configuration is:

```text
OAUTH_CLIENT_ID=https://chatgpt.com/oauth/client.json
OAUTH_REDIRECT_URI=https://chatgpt.com/connector_platform_oauth_redirect
```

These defaults require authorization-server issuer identification and CIMD support, both implemented by the Worker. Replace them only with the exact values shown by the OpenAI app-management surface for this connection.

## Meta configuration

Create one WhatsApp Embedded Signup configuration for the closed pilot. Configure the callback origin to `PUBLIC_ORIGIN` and the WhatsApp webhook callback to:

```text
https://<public-origin>/webhooks/meta/whatsapp
```

Use `META_WEBHOOK_VERIFY_TOKEN` as the webhook verification token and subscribe the required WhatsApp message fields. The onboarding callback exchanges Meta's short-lived authorization code server-side, verifies that the selected phone belongs to the selected WABA, subscribes the app, and encrypts the provider token before persistence.

## Deploy and verify

```text
node ./node_modules/wrangler/bin/wrangler.js deploy --config wrangler.mcp.jsonc
```

Verify, without exposing secrets:

```text
GET  /health
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-authorization-server
GET  /.well-known/jwks.json
POST /mcp
```

`/health` must report `pilotOnboardingConfigured`, `oauthConfigured`, `oauthVerifierConfigured`, and `outboundMessagingConfigured` as `true`. Tool metadata may be discovered without a tenant token, but every tool invocation must authenticate before it reads tenant data or changes state. An unauthenticated invocation returns the MCP OAuth challenge in `mcp/www_authenticate`; an HTTP authorization rejection, when used, must carry the equivalent `WWW-Authenticate` resource-metadata challenge.

## Invite and supervise a client

Keep the administrator token in the process environment and create a one-time, 24-hour invitation:

```text
PILOT_ADMIN_TOKEN=<secret> npm run pilot:admin -- invite https://<public-origin> <tenant-id> "<client label>" client
```

On Daniel's Windows operator host, the token is already stored under the
`AutomatedCo/WhatsAppMCP/PILOT_ADMIN_TOKEN` Generic Credential target. Use the
wrapper below so its value is read directly into the child process environment
and is never copied into the command line or printed:

```text
npm run pilot:admin:windows -- invite https://<public-origin> <tenant-id> "<client label>" client
```

The wrapper removes the temporary process environment value when the command
finishes. The invitation response itself is sensitive because it contains a
one-time link; transmit only that URL to the exact named pilot contact.

If an unused link is lost or suspected to be exposed, rotate it in place. This
does not allocate another cohort seat, and any prior link tracked by the current
runtime is revoked before the replacement is returned:

```text
npm run pilot:admin:windows -- reinvite https://<public-origin> <tenant-id> "<client label>" client
```

Send only the returned one-time invitation URL to the named pilot contact. The invite establishes both the Meta installation and a scoped browser session for the OAuth connection. The client should add `https://<public-origin>/mcp` to ChatGPT from the same browser session.

Check installation state:

```text
PILOT_ADMIN_TOKEN=<secret> npm run pilot:admin -- status https://<public-origin> <tenant-id>
```

The `status`, `disconnect`, and `delete` commands can use the same
`pilot:admin:windows` wrapper on that host.

Before a supervised send, verify the conversation exists, the customer-service window is open, and the reply is expected. Outside the window, enable only an exact Meta-approved template and record the recipient's category and purpose consent in the internal policy API. The MCP performs the same checks again atomically at dispatch time.

## Disconnect and deletion

Disconnect revokes the tenant's pilot browser sessions, authorization codes, refresh tokens, WABA routing, and Meta webhook subscription. Existing access tokens are additionally denied because the installation is no longer connected.

```text
PILOT_ADMIN_TOKEN=<secret> npm run pilot:admin -- disconnect https://<public-origin> <tenant-id>
PILOT_ADMIN_TOKEN=<secret> npm run pilot:admin -- delete https://<public-origin> <tenant-id>
```

Deletion requires a completed disconnect and deletes the tenant installation plus all retained conversation data. Provider-side deletion obligations, audit retention, and client communication remain an operator checklist item.

## Staging acceptance

- Durable Object, OAuth + PKCE, webhook routing, policy, retention, and idempotency tests pass.
- The deployment dry run succeeds with no unintended bindings.
- Live discovery documents return the exact public origin.
- Invalid and replayed invitations fail closed.
- A signed Meta webhook is routed only to its WABA-bound tenant.
- A read-only MCP history call works for the connected tenant and cannot read another tenant.
- One in-window reply succeeds once; the same idempotency key returns the original result.
- A reply at or after the 24-hour boundary returns `WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED` and sends nothing.
- Disconnect invalidates OAuth and provider access; deletion removes retained tenant data.

Do not claim a production-ready or public marketplace state from this checklist. Meta Tech Provider/access verification, production phone/payment setup, privacy/legal review, domain hardening, and OpenAI submission are separate gates.
