# Flow response diagnostics

A phone's submission screen does not prove server-side validation or a saved
appointment. Successful answers remain correlated to the original launch,
tenant, sender, time window and message. Invalid input does not consume that
launch or generate a completion acknowledgment.

`flowSubmission.status = "invalid"` can now include `validationErrors`, an
array of at most twelve fixed field/code pairs. For example:

```json
{"status":"invalid","validationErrors":[{"field":"phone","code":"invalid_format"}]}
```

Fields cover response framing, token, source and the known visit/wholesale
fields. Codes describe required/type/format/length/option/framing failures.
Unknown field names become `response / unsupported_field`; their names and
values are never retained. Zod messages, response JSON, raw tokens and rejected
answers are not diagnostics. Persistence validates the closed vocabulary again.

Existing invalid receipts with no reason remain compatible and unchanged. We
cannot recover their cause retrospectively. A fresh genuine submission is
required to diagnose an earlier incident; never rewrite that earlier receipt
or automatically replace a launch/send key.

The normalized reasons are available through existing authenticated, bounded,
tenant-scoped history. No tool, raw-payload endpoint or additional scope was
added. SQLite reconstruction, real Worker ingestion/correction/deduplication
and the actual MCP SDK output contract exercise the same diagnostics.

The local bot renders these pairs into fixed Spanish inbox feedback while
preserving human review and suppressing completion acknowledgments for invalid
or unmatched submissions. This does not authorize guessing missing answers,
changing conversation ownership or retrying an uncertain provider dispatch.

## Repeatable manual controls

Use `test-fixtures/manual-flow-controls.v1.json` for future owner phone tests.
Its contact field is test form data, never an outbound destination. The date is
an explicit fixture value, not a confirmed booking. Use the same values each
time and vary one field only for a negative case. In the UI, `10_00_am` means
10:00 a.m.; `200_500` is the matching budget option and `both` means both sales
channels. No customer notification, appointment confirmation or real order is
authorized by submitting a control.

The negative visit keeps every baseline answer except phone=`123`. Current
backend validation should return only `phone / invalid_format`, preserve the
original rejected receipt, record no completed form and send no completion
acknowledgment. This is a deliberately invalid control; it is not a claimed
reproduction of a historical submission whose values were not retained.
