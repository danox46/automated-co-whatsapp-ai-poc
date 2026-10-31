# Morning information context

`POST /native/morning-context` is an authenticated native-host exchange. It
accepts a Morning workspace ID and opaque conversation reference. It verifies
the provider OAuth audience and conversation-read scope, derives the tenant from
the configured Morning issuer and workspace, and reads the current installation
and internal conversation enforcement state.

A connected installation, matching provider phone account, verified inbound
sender and active bot ownership are required. The response is a 60-second RS256
assertion for the configured Morning `/extensions/worker` audience. Sender,
workspace and tenant claims come from verified server state. Caller-supplied
phones, customer IDs and destinations are rejected. The native host must keep
the assertion outside the model's tools, messages and logs.

This does not grant general ARP access. Morning must verify the proof and its
separately enrolled device, then recheck current publication and customer
membership for every information operation. Native tooling and that receiving
path remain separate implementation work. Existing OAuth clients and scopes are
unchanged; the endpoint is not an MCP tool.

## Development evidence, 2026-10-31

- Missing-module baseline: `artifacts/morning-context-before.log`.
- Seven focused context tests pass, including foreign workspace, caller
  overrides, scope, disconnected/reconnected account, handoff, malformed/large
  request and sanitized dependency failure cases.
- Actual Worker endpoint baseline returned404. After wiring, a real signed
  provider token produces the expected assertion against durable synthetic
  installation/conversation state; token revocation returns401.
- `npm run verify`: typecheck, 298 tests and build pass.
- `npm run test:workers`: 77 tests pass across 13 files. Logged expected
  conflict exceptions belong to existing negative tests.

Evidence is in `artifacts/morning-context-*.log`. No production deployment,
provider settings, real messages or customer data changed. This is context
issuance proof, not end-to-end customer bot acceptance.
