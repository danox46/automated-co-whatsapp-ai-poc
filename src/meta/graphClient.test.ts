import { describe, expect, it, vi } from "vitest";
import { createMetaGraphClient, MetaGraphError } from "./graphClient.js";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Meta Graph client", () => {
  it("exchanges a code, verifies WABA ownership, and subscribes the app", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: "secret-token", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ data: [{ id: "2222", verified_name: "Pilot" }] }))
      .mockResolvedValueOnce(json({ success: true }));
    const client = createMetaGraphClient({
      appId: "app",
      appSecret: "secret",
      graphVersion: "v25.0",
      fetch: request
    });

    const token = await client.exchangeEmbeddedSignupCode("A2345678901234567890");
    expect(token.accessToken).toBe("secret-token");
    await expect(client.verifyPhoneBelongsToWaba(token.accessToken, "1111", "2222"))
      .resolves.toMatchObject({ id: "2222", verifiedName: "Pilot" });
    await expect(client.subscribeApp(token.accessToken, "1111")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[0][0])).not.toContain("secret-token");
  });

  it("rejects a phone number that is not owned by the selected WABA", async () => {
    const client = createMetaGraphClient({
      appId: "app",
      appSecret: "secret",
      graphVersion: "v25.0",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json({ data: [{ id: "3333" }] }))
    });
    await expect(client.verifyPhoneBelongsToWaba("token", "1111", "2222"))
      .rejects.toMatchObject({ code: "META_PHONE_NOT_IN_WABA", status: 403 });
  });

  it("accepts only a provider-approved template with the exact language", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({
      data: [{ name: "support_followup", status: "APPROVED", category: "UTILITY", language: "es_CO" }]
    }));
    const client = createMetaGraphClient({
      appId: "app",
      appSecret: "secret",
      graphVersion: "v25.0",
      fetch: request
    });
    await expect(client.verifyApprovedTemplate("token", "1111", "support_followup", "es_CO"))
      .resolves.toEqual({ name: "support_followup", category: "UTILITY", languageCode: "es_CO" });
    expect(String(request.mock.calls[0][0])).toContain("message_templates");
    expect(String(request.mock.calls[0][0])).not.toContain("token");
  });

  it("returns sanitized provider errors without response messages", async () => {
    const client = createMetaGraphClient({
      appId: "app",
      appSecret: "secret",
      graphVersion: "v25.0",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json({
        error: { code: 190, message: "provider secret detail" }
      }, 401))
    });
    const error = await client.exchangeEmbeddedSignupCode("A2345678901234567890").catch((value) => value);
    expect(error).toBeInstanceOf(MetaGraphError);
    expect(error.message).toBe("META_CODE_EXCHANGE_FAILED_190");
    expect(error.message).not.toContain("provider secret detail");
  });
});
