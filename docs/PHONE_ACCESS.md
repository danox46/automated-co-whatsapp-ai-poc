# Phone inbox

Open **https://inbox.danienremoto.com** and enter the owner password. No username
is required. Find the initial password in ignored `.runtime/phone-login.txt`;
save it in a password manager and remove that initial note afterward.

The owner approved Cloudflare Tunnel with an inbox password login on 2026-09-04.
This replaces the proposed Cloudflare Access deployment. No Access subscription
or payment method is used.

## Running

`npm run inbox` builds and starts the inbox, password gateway and named phone
tunnel when `.runtime/phone-auth.json` and `.runtime/phone-tunnel-token` exist.
`npm start` starts the already-built components. The PC must be awake and online.
For separate diagnostics use `npm run phone:gateway` and `npm run phone:tunnel`;
do not start duplicates on the same ports.

## Access boundary

- The named tunnel routes the hostname only to `http://127.0.0.1:3101` with
  `httpHostHeader: inbox.danienremoto.com`. Its catch-all returns 404.
- Port 3101 is a loopback password gateway with one fixed upstream: the existing
  PC-local inbox on port 3100. Twilio port 3000 remains independent.
- All remote assets, messages, media, API and SSE require a session except the
  login/logout pages. Credentials are scrypt-hashed with a random salt.
- Sessions use random 256-bit tokens stored hashed in memory, delivered in
  Secure, HttpOnly, SameSite=Strict cookies, and expire after 12 hours.
- Writes require the exact HTTPS Origin. Login attempts are throttled both per
  client and globally. TLS verification remains enabled.
- Responses use no-store plus CSP, anti-framing and HSTS headers.
- Log out at `/auth/logout`. Logout revokes the session and closes its streams.
  Restarting the gateway also invalidates every session.
- Authentication settings, password delivery note, and tunnel credentials are
  machine-local and ignored under `.runtime/`. Never include them in Git,
  dashboard state, command output, or URLs.

## Verification and rollback

`npm run test:phone` verifies protected routes, forged cookies, host checks,
cross-origin writes, authenticated forwarding, expiry, logout, and brute-force
limits against a mocked origin; it sends no WhatsApp messages.

Live checks verify anonymous API/media/SSE returns 401, login and authenticated
conversation reads succeed, cross-origin writes fail, and logout revokes access.
Phone browser rendering must be checked separately from HTTP/API tests.

Disable the dedicated route or stop the phone tunnel to remove remote access.
Retain local SQLite and media under the manual-deletion policy.
