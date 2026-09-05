import { describe, expect, it } from "vitest";
import {
  assertAllowedWhatsAppMcpTool,
  evaluateWhatsAppMcpAction,
  WHATSAPP_MCP_TOOL_ALLOWLIST,
  WHATSAPP_MCP_WRITE_ACTIONS
} from "./whatsappPolicy.js";

describe("WhatsApp MCP policy", () => {
  it("registers only read-only policy and status tools", () => {
    expect(WHATSAPP_MCP_TOOL_ALLOWLIST).toEqual([
      "whatsapp_get_policy",
      "whatsapp_get_connection_status",
      "whatsapp_evaluate_action"
    ]);
    expect(WHATSAPP_MCP_TOOL_ALLOWLIST.some((name) => /send|delete|webhook|export/i.test(name))).toBe(false);
  });

  it.each(WHATSAPP_MCP_WRITE_ACTIONS)("denies write action %s", (action) => {
    const result = evaluateWhatsAppMcpAction(action);
    expect(result.allowed).toBe(false);
    expect(result.requiredNextStep).toContain("owner review");
  });

  it("allows only read-only policy checks", () => {
    expect(evaluateWhatsAppMcpAction("read_policy").allowed).toBe(true);
    expect(evaluateWhatsAppMcpAction("read_connection_status").allowed).toBe(true);
  });

  it("rejects unknown and path-like tool names", () => {
    expect(() => assertAllowedWhatsAppMcpTool("whatsapp_send_message")).toThrow();
    expect(() => assertAllowedWhatsAppMcpTool("../whatsapp_get_policy")).toThrow();
  });
});
