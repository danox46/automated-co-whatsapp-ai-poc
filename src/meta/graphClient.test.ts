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

  it("reads back the app subscription without exposing the access token in the URL", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({
      data: [{ whatsapp_business_api_data: { id: "1794512451561594", name: "Morning ARP Connect" } }]
    }));
    const client = createMetaGraphClient({
      appId: "1794512451561594",
      appSecret: "secret",
      graphVersion: "v25.0",
      fetch: request
    });

    await expect(client.isAppSubscribed("provider-token", "934775242587261")).resolves.toBe(true);
    expect(String(request.mock.calls[0][0])).not.toContain("provider-token");
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

  it("retrieves and downloads media through the bounded authenticated media route", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/example",
        mime_type: "image/png",
        sha256: "provider-sha256",
        file_size: bytes.byteLength
      }))
      .mockResolvedValueOnce(new Response(bytes, {
        headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) }
      }));
    const client = createMetaGraphClient({
      appId: "app",
      appSecret: "secret",
      graphVersion: "v25.0",
      fetch: request
    });

    const metadata = await client.retrieveMediaMetadata("provider-token", "123456789", "987654321");
    expect(metadata).toMatchObject({ mimeType: "image/png", fileSize: bytes.byteLength });
    expect(String(request.mock.calls[0][0])).toContain("phone_number_id=987654321");
    expect(String(request.mock.calls[0][0])).not.toContain("provider-token");
    const downloaded = await client.downloadMedia("provider-token", metadata.url, 1024);
    expect(downloaded.bytes).toEqual(bytes);
    expect(downloaded.contentType).toBe("image/png");
    expect(request.mock.calls[1][1]?.headers).toEqual({ Authorization: "Bearer provider-token" });
    expect(request.mock.calls[1][1]?.redirect).toBe("manual");
  });

  it("follows only a bounded Meta-owned media redirect chain", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://scontent.xx.fbcdn.net/whatsapp_business/attachment" }
      }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "image/jpeg" } }));
    const client = createMetaGraphClient({
      appId: "app",
      appSecret: "secret",
      graphVersion: "v25.0",
      fetch: request
    });

    await expect(client.downloadMedia(
      "provider-token",
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/example",
      1024
    )).resolves.toMatchObject({ bytes, contentType: "image/jpeg" });
    expect(String(request.mock.calls[1][0])).toContain(".fbcdn.net/");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects non-Meta media delivery hosts", async () => {
    const client = createMetaGraphClient({
      appId: "app",
      appSecret: "secret",
      graphVersion: "v25.0",
      fetch: vi.fn<typeof fetch>()
    });
    await expect(client.downloadMedia("provider-token", "https://example.com/private", 1024))
      .rejects.toMatchObject({ code: "META_MEDIA_URL_INVALID" });
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
