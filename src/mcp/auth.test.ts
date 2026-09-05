import { describe, expect, it } from "vitest";
import { authorizeWhatsAppMcpRequest, type WhatsAppMcpTokenVerifier } from "./auth.js";

const audience = "https://mcp.example.test";

describe("WhatsApp MCP principal binding", () => {
  it("requires a non-empty subject, tenant, and exact audience", async () => {
    const request = new Request(`${audience}/mcp`, {
      headers: { Authorization: "Bearer test-token" }
    });
    const cases = [
      { subject: "", tenantId: "tenant-1", audience },
      { subject: "owner", tenantId: "", audience },
      { subject: "owner", tenantId: "tenant-1", audience: "https://other.example.test" }
    ];
    for (const principal of cases) {
      const verifier: WhatsAppMcpTokenVerifier = async () => ({
        ...principal,
        scopes: new Set(["whatsapp.conversations.read"])
      });
      await expect(authorizeWhatsAppMcpRequest(request, audience, verifier)()).resolves.toBeNull();
    }
  });

  it("returns the verifier-bound tenant without reading it from tool arguments", async () => {
    const request = new Request(`${audience}/mcp`, {
      headers: { Authorization: "Bearer test-token" }
    });
    const verifier: WhatsAppMcpTokenVerifier = async () => ({
      subject: "owner",
      tenantId: "tenant-1",
      audience,
      scopes: new Set(["whatsapp.conversations.read"])
    });
    await expect(authorizeWhatsAppMcpRequest(request, audience, verifier)()).resolves.toMatchObject({
      tenantId: "tenant-1"
    });
  });
});
