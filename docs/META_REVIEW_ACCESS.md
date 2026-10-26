# Meta reviewer access

The public `/pilot/whatsapp/connect` page accepts an invitation code. Opening
that page does not create a session or load Meta's signup SDK. An invalid or
expired invitation returns a usable error page without reflecting the code;
an invalid invitation cookie is cleared.

## Operator preparation

Use the existing protected `scripts/pilot-admin.ps1` wrapper with
`review-invite <https-origin> <fresh-meta-review-tenant> <label>`.
`review-reinvite` rotates an unused invitation for that same tenant. The tenant
must use the `meta-review-` namespace and the client cohort. Capture the returned
invitation privately: its URL/code is an access-bearing secret, unsuitable for
Git, operational records or diagnostic output.

Review invitations use explicit `purpose: meta_app_review` and expire after
400 days by default. This is initial enrollment validity, not a permanent login
or reusable invitation. Issue the final invitation near submission and check
that its expiry covers Meta's requested review period. Ordinary pilot invitations
retain their 24-hour default/72-hour maximum; app-owned sandbox invitations
retain their 24-hour maximum. Review invitations consume the existing client
cohort capacity and do not increase limits, scopes or recipient access.

## Intended review path

1. Supply a dedicated, scoped invitation and suitable test-business assets.
2. The authorized administrator opens the invitation, completes official
   WhatsApp Embedded Signup and selects that business's WABA and number.
3. In the same browser, connect the MCP endpoint through the supported client
   OAuth flow. The resulting pilot browser session lasts 30 days; MCP refresh
   follows the existing rotating-token policy. Explicit Morning operator
   assignments provide the existing re-entry path.
4. Exercise connection status and bounded conversation reads, then authorized
   replies/templates against the supplied test conversation. Record actual
   provider receipts separately from automated fixtures.

Do not use the owner's Google session or connect a review tenant to the live
Morning/El Portal account. Do not claim successful reviewer access from an
anonymous page load or a synthetic OAuth test. A working enrollment path and
actual intended-client acceptance remain distinct from Meta's later review.

## Shared-account protection and recovery

An already-bound WABA is rejected before subscribing the app. Concurrent claims
are serialized by the WABA Durable Object before writing the tenant installation.
Cleanup can delete only the expected owner's route. A callback/session failure
must not unsubscribe a completed installation, another tenant's connection, or
an account whose ownership cannot be determined. Preserve uncertain outcomes
for reconciliation instead of repeating the one-use Meta authorization code.

These repairs do not submit App Review, upload videos, publish WhatsApp Flows,
create reviewer invitations, or alter existing business assignments by themselves.
