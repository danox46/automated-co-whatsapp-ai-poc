import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetaGraphClient } from "./graphClient.js";

afterEach(() => vi.useRealTimers());
function stalledResponse() {
  const cancel = vi.fn();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; }, cancel
  }));
  return { response, cancel, controller };
}
function client(request: typeof fetch) {
  return createMetaGraphClient({ appId: "app", appSecret: "fixture-secret", graphVersion: "v25.0", timeoutMs: 100, fetch: request });
}

describe("complete Meta operation deadlines", () => {
  const actions = {
    send: (c: ReturnType<typeof client>) => c.sendText("fixture-token", "123456789", "15550000001", "Hi"),
    template: (c: ReturnType<typeof client>) => c.sendTemplate("fixture-token", "123456789", "15550000001", "status_update", "en_US", []),
    exchange: (c: ReturnType<typeof client>) => c.exchangeEmbeddedSignupCode("A2345678901234567890"),
    subscription: (c: ReturnType<typeof client>) => c.isAppSubscribed("fixture-token", "987654321"),
    media: (c: ReturnType<typeof client>) => c.downloadMedia("fixture-token", "https://lookaside.fbsbx.com/fixture", 1024)
  };
  for (const [name, action] of Object.entries(actions)) {
    it(`times out and cancels a stalled ${name} body after timely headers`, async () => {
      vi.useFakeTimers();
      const fixture = stalledResponse();
      const request = vi.fn<typeof fetch>().mockResolvedValue(fixture.response);
      const result = action(client(request));
      const assertion = expect(result).rejects.toMatchObject({ code: "META_REQUEST_TIMEOUT", status: 504, retryable: true });
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(fixture.cancel).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(request).toHaveBeenCalledTimes(1);
    });
  }
  it("does not reset the deadline when response chunks arrive", async () => {
    vi.useFakeTimers();
    const fixture = stalledResponse();
    const result = client(vi.fn<typeof fetch>().mockResolvedValue(fixture.response)).sendText("token", "123456789", "15550000001", "Hi");
    const assertion = expect(result).rejects.toMatchObject({ code: "META_REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(60);
    fixture.controller.enqueue(new TextEncoder().encode('{"messages":'));
    await vi.advanceTimersByTimeAsync(39);
    expect(fixture.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
  });
  it("clears the deadline after a complete bounded body succeeds", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ messages: [{ id: "wamid.fixture" }] }));
    expect(await client(request).sendText("token", "123456789", "15550000001", "Hi")).toEqual({ messageRef: "wamid.fixture", status: "accepted" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });
  for (const declared of [false, true]) {
    it(`preserves the JSON byte cap with ${declared ? "declared" : "streamed"} oversized responses`, async () => {
      const bytes = new TextEncoder().encode("x".repeat(64 * 1024 + 1));
      const response = new Response(bytes, declared ? { headers: { "content-length": String(bytes.length) } } : undefined);
      await expect(client(vi.fn<typeof fetch>().mockResolvedValue(response)).sendText("token", "123456789", "15550000001", "Hi"))
        .rejects.toMatchObject({ code: "META_RESPONSE_TOO_LARGE" });
    });
  }
  it("preserves the media byte cap", async () => {
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1025)))).downloadMedia("token", "https://lookaside.fbsbx.com/fixture", 1024))
      .rejects.toMatchObject({ code: "META_MEDIA_TOO_LARGE" });
  });
  it("uses one deadline across media redirects and the final body", async () => {
    vi.useFakeTimers();
    const fixture = stalledResponse();
    let calls = 0;
    const request = vi.fn<typeof fetch>(async () => {
      calls++;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response(null, { status: 302, headers: { location: "https://scontent.xx.fbcdn.net/fixture" } });
      }
      return fixture.response;
    });
    const result = client(request).downloadMedia("token", "https://lookaside.fbsbx.com/fixture", 1024);
    const assertion = expect(result).rejects.toMatchObject({ code: "META_REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(request).toHaveBeenCalledTimes(2);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[1][1]?.signal).toBe(request.mock.calls[0][1]?.signal);
  });
});
