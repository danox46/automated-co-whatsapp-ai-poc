import { describe, expect, it } from "vitest";
import {
  decryptPilotSecret,
  encryptPilotSecret,
  randomBase64Url,
  secureEqualText,
  sha256Base64Url
} from "./pilotCrypto.js";

describe("pilot crypto", () => {
  it("round-trips encrypted provider credentials without retaining plaintext", async () => {
    const key = randomBase64Url(32);
    const encrypted = await encryptPilotSecret("provider-token", key);

    expect(encrypted.ciphertext).not.toContain("provider-token");
    await expect(decryptPilotSecret(encrypted, key)).resolves.toBe("provider-token");
  });

  it("rejects the wrong encryption key", async () => {
    const encrypted = await encryptPilotSecret("provider-token", randomBase64Url(32));
    await expect(decryptPilotSecret(encrypted, randomBase64Url(32))).rejects.toThrow();
  });

  it("creates URL-safe random values and stable hashes", async () => {
    const token = randomBase64Url();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(await sha256Base64Url("same")).toBe(await sha256Base64Url("same"));
    await expect(secureEqualText("same", "same")).resolves.toBe(true);
    await expect(secureEqualText("same", "different")).resolves.toBe(false);
  });
});
