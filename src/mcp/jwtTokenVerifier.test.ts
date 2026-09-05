import { describe, expect, it } from "vitest";
import { signRs256Jwt } from "../oauth/jwt.js";
import { createJwtWhatsAppMcpTokenVerifier } from "./jwtTokenVerifier.js";

const issuer = "https://auth.example.test";
const audience = "https://mcp.example.test";
const now = new Date("2026-09-05T18:00:00.000Z");

describe("JWT WhatsApp MCP token verifier", () => {
  it("accepts a signed, resource-bound, active tenant token", async () => {
    const keys = await createKeys("key-1");
    const token = await issue(keys.privateJwk, "key-1", {});
    const verifier = createJwtWhatsAppMcpTokenVerifier({
      issuer,
      audience,
      now: () => now,
      resolvePublicJwk: async (header) => header.kid === "key-1" ? keys.publicJwk : null
    });

    await expect(verifier(token, new Request(`${audience}/mcp`))).resolves.toMatchObject({
      subject: "user-1",
      tenantId: "tenant-1",
      audience,
      tokenId: "token-1"
    });
    const principal = await verifier(token, new Request(`${audience}/mcp`));
    expect(principal?.scopes).toEqual(new Set(["whatsapp.policy.read", "whatsapp.conversations.read"]));
  });

  it.each([
    ["wrong issuer", { iss: "https://other.example.test" }],
    ["wrong audience", { aud: "https://other.example.test" }],
    ["expired", { exp: Math.floor(now.getTime() / 1000) - 31 }],
    ["not active", { nbf: Math.floor(now.getTime() / 1000) + 31 }],
    ["future issued-at", { iat: Math.floor(now.getTime() / 1000) + 31 }],
    ["missing tenant", { tenant_id: "" }]
  ])("rejects %s claims", async (_label, overrides) => {
    const keys = await createKeys("key-1");
    const token = await issue(keys.privateJwk, "key-1", overrides);
    const verifier = createJwtWhatsAppMcpTokenVerifier({
      issuer,
      audience,
      now: () => now,
      resolvePublicJwk: async () => keys.publicJwk
    });
    await expect(verifier(token, new Request(`${audience}/mcp`))).resolves.toBeNull();
  });

  it("rejects unknown keys, invalid signatures, and revoked token IDs", async () => {
    const trusted = await createKeys("trusted");
    const attacker = await createKeys("attacker");
    const unknownKeyToken = await issue(attacker.privateJwk, "attacker", {});
    const forgedToken = await issue(attacker.privateJwk, "trusted", {});
    const revokedToken = await issue(trusted.privateJwk, "trusted", { jti: "revoked-token" });
    const verifier = createJwtWhatsAppMcpTokenVerifier({
      issuer,
      audience,
      now: () => now,
      resolvePublicJwk: async (header) => header.kid === "trusted" ? trusted.publicJwk : null,
      isTokenRevoked: async (tokenId) => tokenId === "revoked-token"
    });

    await expect(verifier(unknownKeyToken, new Request(`${audience}/mcp`))).resolves.toBeNull();
    await expect(verifier(forgedToken, new Request(`${audience}/mcp`))).resolves.toBeNull();
    await expect(verifier(revokedToken, new Request(`${audience}/mcp`))).resolves.toBeNull();
  });
});

async function createKeys(kid: string) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateJwk: { ...privateJwk, kid, alg: "RS256", use: "sig" },
    publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" }
  };
}

async function issue(privateJwk: JsonWebKey, kid: string, overrides: Record<string, unknown>) {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return signRs256Jwt({ alg: "RS256", kid, typ: "at+jwt" }, {
    iss: issuer,
    aud: audience,
    sub: "user-1",
    tenant_id: "tenant-1",
    scope: "whatsapp.policy.read whatsapp.conversations.read",
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 300,
    jti: "token-1",
    ...overrides
  }, privateJwk);
}
