import { describe, expect, it } from "vitest";
import { flowToken, parseFlowReply } from "./flowResponses.js";
import { sha256Base64Url } from "./pilotCrypto.js";

const token = `flow_${"a".repeat(43)}`;
const visit = { flow_token: token, source: "visit_schedule_flow", customer_name: "Synthetic Tester", phone: "+15550000001", visit_date: "2026-11-02", visit_time: "10_00_am", notes: "Synthetic test only" };
function reply(payload: unknown) {
  return { type: "interactive", context: { id: "wamid.flow-launch" }, interactive: { type: "nfm_reply", nfm_reply: { body: "Sent", response_json: JSON.stringify(payload) } } };
}
describe("bounded Flow reply normalization", () => {
  it("extracts exact visit answers, not the generic body, raw token or provider envelope", async () => {
    const candidate = await parseFlowReply(reply(visit));
    expect(candidate).toEqual({ tokenHash: await sha256Base64Url(token), contextMessageRef: "wamid.flow-launch", form: { kind: "visit", answers: { customer_name: "Synthetic Tester", phone: "+15550000001", visit_date: "2026-11-02", visit_time: "10_00_am", notes: "Synthetic test only" } } });
    expect(JSON.stringify(candidate)).not.toContain(token);
    expect(JSON.stringify(candidate)).not.toContain("response_json");
  });
  it("supports the existing wholesale fields", async () => {
    const candidate = await parseFlowReply(reply({ flow_token: token, source: "wholesale_flow", city: "Bogotá", budget_range: "200_500", selling_status: "not_yet" }));
    expect(candidate?.form).toEqual({ kind: "wholesale", answers: { city: "Bogotá", budget_range: "200_500", selling_status: "not_yet" } });
  });
  it("accepts an empty optional note without advertising a JSON-Schema transform", async () => {
    expect((await parseFlowReply(reply({ ...visit, notes: null })))?.form).toMatchObject({ kind: "visit" });
  });
  for (const invalid of [
    { ...visit, extra_provider_data: "must-not-be-stored" },
    { ...visit, source: "unregistered_form" },
    { ...visit, visit_date: "2026-02-30" },
    { ...visit, visit_time: "unknown" },
    { ...visit, notes: "x".repeat(2001) },
    { ...visit, customer_name: { nested: "not allowed" } },
    null, [visit]
  ]) {
    it("rejects unknown, invalid or unbounded form fields without preserving their payload", async () => {
      const candidate = await parseFlowReply(reply(invalid));
      expect(candidate?.form).toBeUndefined();
      expect(JSON.stringify(candidate)).not.toContain("must-not-be-stored");
    });
  }
  it("records malformed/oversize nfm replies as invalid candidates and leaves ordinary messages alone", async () => {
    expect(await parseFlowReply({ type: "text", text: { body: "hello" } })).toBeUndefined();
    expect(await parseFlowReply({ type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: "{" } } })).toEqual({});
    expect(await parseFlowReply(reply({ ...visit, notes: "x".repeat(9000) }))).toEqual({});
  });
  it("derives repeatable secret-bound tokens that vary by tenant, conversation and original intent", async () => {
    const original = await flowToken("synthetic-secret", "tenant-a", "conv-a", "key-a");
    expect(original).toMatch(/^flow_[A-Za-z0-9_-]{43}$/u);
    expect(await flowToken("synthetic-secret", "tenant-a", "conv-a", "key-a")).toBe(original);
    for (const values of [ ["other-secret", "tenant-a", "conv-a", "key-a"], ["synthetic-secret", "tenant-b", "conv-a", "key-a"], ["synthetic-secret", "tenant-a", "conv-b", "key-a"], ["synthetic-secret", "tenant-a", "conv-a", "key-b"] ]) {
      expect(await flowToken(...values as [string, string, string, string])).not.toBe(original);
    }
  });
});
