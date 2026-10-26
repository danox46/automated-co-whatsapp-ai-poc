import { describe, expect, it, vi } from "vitest";
import { persistMetaAccountUpdates } from "./accountUpdates.js";

const appId = "1794512451561594";
const occurredAt = "2026-10-26T12:00:00.000Z";
const payload = (value: unknown, id = "444444444444") => ({ object: "whatsapp_business_account",
  entry: [{ id, time: Date.parse(occurredAt) / 1000, changes: [{ field: "account_update", value }] }] });

describe("signed account update normalization", () => {
  it("uses the customer's WABA rather than the partner portfolio, retaining no raw business details", async () => {
    const record = vi.fn(async () => undefined);
    await persistMetaAccountUpdates(payload({ event: "PARTNER_ADDED", waba_info: {
      waba_id: "555555555555", owner_business_id: "666666666666", private_field: "private" } }), appId, record);
    expect(record).toHaveBeenCalledExactlyOnceWith({ wabaId: "555555555555", event: "PARTNER_ADDED", occurredAt });
  });

  it("ignores unrelated applications and malformed partner assets", async () => {
    const record = vi.fn(async () => undefined);
    await persistMetaAccountUpdates(payload({ event: "PARTNER_APP_UNINSTALLED", waba_info: {
      waba_id: "555555555555", partner_app_id: "999999999999" } }), appId, record);
    await persistMetaAccountUpdates(payload({ event: "PARTNER_REMOVED" }), appId, record);
    expect(record).not.toHaveBeenCalled();
  });

  it("accepts this app's installation event and direct WABA events independently in a batch", async () => {
    const record = vi.fn(async () => undefined);
    const first = payload({ event: "PARTNER_APP_INSTALLED", waba_info: {
      waba_id: "555555555555", partner_app_id: appId } });
    first.entry.push(...payload({ event: "ACCOUNT_DELETED" }, "777777777777").entry);
    await persistMetaAccountUpdates(first, appId, record);
    expect(record.mock.calls).toEqual([
      [{ wabaId: "555555555555", event: "PARTNER_APP_INSTALLED", occurredAt }],
      [{ wabaId: "777777777777", event: "ACCOUNT_DELETED", occurredAt }]
    ]);
  });

  it("does not retain unknown fields, event text or invalid timestamps", async () => {
    const record = vi.fn(async () => undefined);
    await persistMetaAccountUpdates(payload({ event: "PRIVATE_NEW_EVENT", text: "private" }), appId, record);
    const invalid = payload({ event: "ACCOUNT_DELETED" }); invalid.entry[0].time = Infinity;
    await persistMetaAccountUpdates(invalid, appId, record);
    await persistMetaAccountUpdates({ object: "other", entry: payload({ event: "ACCOUNT_DELETED" }).entry }, appId, record);
    expect(record).not.toHaveBeenCalled();
  });

  it("uses the direct WABA for certification events without partner asset metadata", async () => {
    const record = vi.fn(async () => undefined);
    await persistMetaAccountUpdates(payload({ event: "PARTNER_CLIENT_CERTIFICATION_STATUS_UPDATE",
      partner_client_certification_info: { client_business_id: "999999999999", status: "APPROVED" } }), appId, record);
    expect(record).toHaveBeenCalledExactlyOnceWith({ wabaId: "444444444444", event: "PARTNER_CLIENT_CERTIFICATION_STATUS_UPDATE", occurredAt });
  });

  it("propagates storage failure so the verified webhook can request provider retry", async () => {
    await expect(persistMetaAccountUpdates(payload({ event: "ACCOUNT_DELETED" }), appId,
      async () => { throw new Error("storage unavailable"); })).rejects.toThrow("storage unavailable");
  });
});
