import { describe, expect, it } from "vitest";
import { nativeBotOAuthClient, NATIVE_WHATSAPP_BOT_CLIENT_ID } from "./nativeBotClient.js";
import { createStaticOAuthClientRegistry } from "./authorizationServer.js";

describe("optional native bot client", () => {
  it("leaves native enrollment disabled unless its exact loopback callback is configured", async () => {
    expect(nativeBotOAuthClient()).toBeNull();
    const native = nativeBotOAuthClient("http://127.0.0.1:9468/callback")!;
    const existing = { clientId: "https://chatgpt.com/oauth/client.json", redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"] };
    const registry = createStaticOAuthClientRegistry([existing, native]);
    expect(await registry.resolve(existing.clientId)).toEqual(existing);
    expect(await registry.resolve(NATIVE_WHATSAPP_BOT_CLIENT_ID)).toEqual(native);
    expect(await registry.resolve("unknown-native-client")).toBeNull();
  });
  it("rejects non-loopback, implicit ports, credentials, redirects and callback query fragments", () => {
    for (const url of ["https://127.0.0.1:9468/callback", "http://localhost:9468/callback",
      "http://example.test:9468/callback", "http://127.0.0.1/callback", "http://127.0.0.1:0/callback", "http://127.0.0.1:9468/other",
      "http://user@127.0.0.1:9468/callback", "http://127.0.0.1:9468/callback?next=evil", "http://127.0.0.1:9468/callback#token"]) {
      expect(() => nativeBotOAuthClient(url)).toThrow();
    }
  });
});
