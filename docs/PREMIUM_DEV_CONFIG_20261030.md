# Premium development configuration evidence

`wrangler.premium-dev.jsonc` prepares a distinct `morning-whatsapp-premium-dev`
Worker on `premium-whatsapp-dev.morningarp.com`. Its three Durable Object classes
bind to this Worker, with no external script or namespace reference. Existing
pilot settings, senders and credentials are not copied.

Customer identity points to `https://premium-dev.morningarp.com`, using client
`whatsapp-customer`. The native callback is `http://127.0.0.1:9468/callback`.
The paired ARP client registration returns to this host's `/premium/auth/callback`.

Verification on 2026-10-30:

- Three acceptance tests first failed because the isolated config was absent,
  then passed. They cover resource separation, issuer/native callback binding,
  and omission of inherited pilot configuration.
- `npm run verify` passed: typecheck, 291 tests, build.
- Wrangler 4.152.0 `deploy --dry-run --config wrangler.premium-dev.jsonc` compiled
  the actual provider Worker successfully. The generated bundle is retained in
  `.runtime/premium-development-worker-20261030`.
- Logs: `output/premium-development-config-before-20261030.log`,
  `output/premium-development-config-after-20261030.log`,
  `output/premium-development-full-20261030.log`, and
  `output/premium-development-worker-20261030.log`.

This is configuration preparation, not a deployed or working provider connection.
Domain/resource deployment and provider registration remain pending approval.
Meta app/signup configuration, matching webhook registration and host secrets
must be provisioned before real onboarding. Signing, encryption, conversation
reference and administration secrets must be specific to this deployment.
No Meta messages or hosted writes occurred.
