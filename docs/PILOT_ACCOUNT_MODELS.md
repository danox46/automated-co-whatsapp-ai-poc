# Pilot account models

The existing owner administrator can record an installation's account model,
phone owner, Messaging Account owner, Meta payer and funding evidence. These
are separate facts. A connected phone, successful message or unavailable
`primary_funding_id` query does not establish a client's commercial billing
arrangement. In particular, a BSP-only query being denied is unavailable
evidence, not a missing card.

The supported model names are `internal-demo`, `morning-managed` and
`client-direct`. Internal demos must not be relabeled as client installations
without actual client authority. For the managed plan, Morning supplies the
number and Morning or a supported upstream partner pays Meta; a recorded client
owner/payer is flagged as a mismatch. For the client-direct plan, the client
retains the phone and Messaging Account and pays Meta; a recorded Morning or
partner owner/payer is flagged as a mismatch. These are review signals, not
proof of Tech Provider/BSP entitlement or transfer authority.

## Owner administration

Use the existing protected admin wrapper, with the same managed credential:

```powershell
./scripts/pilot-admin.ps1 account-profile https://EXISTING-ORIGIN TENANT
./scripts/pilot-admin.ps1 set-account-profile https://EXISTING-ORIGIN TENANT C:/PRIVATE/profile-command.json
```

The first is read-only. The second accepts a full strict command; for example:

```json
{
  "expectedRevision": 0,
  "intentKey": "pilot-model-original-intent-v1",
  "profile": {
    "model": "morning-managed",
    "phoneOwner": {"value": "unverified"},
    "messagingAccountOwner": {"value": "unverified"},
    "metaPayer": {"value": "unverified"},
    "funding": {"value": "unverified"}
  }
}
```

Parties can instead be `morning`, `client` or `upstream-partner`, accompanied by
`evidence: {source: "owner" | "provider", ref: "sanitized-evidence-reference",
observedAt: "2026-10-25T12:00:00.000Z"}`. Funding accepts `recorded` or
`provider-unavailable` with the same evidence shape. Keep references free of
tokens, query strings, customer data and credentials. Evidence is explicitly
operator-recorded; this endpoint does not independently inspect Meta billing.
An evidence-recorded result is not authorization to launch a client.

PUT `/admin/pilot/installations/:tenant/account-profile` requires the existing
admin token, original intent key and current profile revision. GET on the same
path returns the sanitized model/review state. No connected-agent MCP tool or
scope is added. Requests cannot set provider IDs, tokens, another tenant or
arbitrary extra fields. The backend binds evidence to the installation's actual
phone and Messaging Account internally, omitting those identifiers from output.

Profiles and original command receipts live in the tenant's existing Durable
Object in additive tables. A legacy installation has `profile: null`; existing
credentials and send authorization are unchanged. Refreshing credentials for
the same assets preserves the profile. A different phone/account or a
disconnected installation returns `needs-reverification` while retaining the
old evidence. Explicit installation deletion removes the profile and its
receipts along with the installation; disconnect alone retains them.

Writes compare revisions and retain original command receipts atomically.
Retry the same command after an uncertain result, then read back current state.
A recovered older receipt reports its original revision and never overwrites
a newer profile. A changed body under the same key or stale new write conflicts.

## Remaining pilot acceptance

This records the chosen arrangement; it does not configure a credit line,
move/delete a phone account, purchase a number, share assets or charge anyone.
`billingCollection: "not-configured"` remains explicit, including for a fully
evidenced profile. Actual fee collection, tenant usage/cost reconciliation,
client ownership/exit and separate client sign-in/inbound/reply/media/delivery/
disconnect/reconnect testing remain required before a paid pilot launch.
Do not rebill client-direct Meta usage as Morning-funded usage. No tariff,
balance, debit, top-up or commercial permission is inferred here.

The existing App Review and Flow publication holds remain in effect. Retaining
source and not deploying this addition rolls back its availability without
changing the existing installation. Once deployed, omit the new admin command
to stop using it; do not roll back or delete conversation data to remove a
profile. Never bypass the API by writing operational SQLite directly.
