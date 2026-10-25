import { describe, expect, it } from "vitest";
import {
  assertAllowedWhatsAppMcpTool,
  evaluateWhatsAppMcpAction,
  WHATSAPP_MCP_CONVERSATION_READ_TOOL_ALLOWLIST,
  WHATSAPP_MCP_READ_TOOL_ALLOWLIST,
  WHATSAPP_MCP_TOOL_ALLOWLIST,
  WHATSAPP_MCP_WRITE_TOOL_ALLOWLIST,
  WHATSAPP_MCP_WRITE_ACTIONS,
  WHATSAPP_POLICY_URLS,
  WHATSAPP_POLICY_VERSION
} from "./whatsappPolicy.js";

describe("WhatsApp MCP policy", () => {
  it("advertises the current Morning integration notices, not legacy brand policies", () => {
    expect(WHATSAPP_POLICY_VERSION).toBe("2026-10-24");
    expect(WHATSAPP_POLICY_URLS).toEqual({
      overview: "https://morningarp.com/products/whatsapp-bot/",
      privacy: "https://morningarp.com/integrations/whatsapp/privacy/",
      terms: "https://morningarp.com/integrations/whatsapp/terms/",
      deletion: "https://morningarp.com/integrations/whatsapp/deletion/",
      support: "https://morningarp.com/contact/"
    });
  });
  it("defines read tools and provider-backed messaging tools separately", () => {
    expect(WHATSAPP_MCP_READ_TOOL_ALLOWLIST).toEqual([
      "whatsapp_get_policy",
      "whatsapp_get_connection_status",
      "whatsapp_evaluate_action"
    ]);
    expect(WHATSAPP_MCP_CONVERSATION_READ_TOOL_ALLOWLIST).toEqual([
      "whatsapp_list_conversations",
      "whatsapp_get_conversation_history"
    ]);
    expect(WHATSAPP_MCP_WRITE_TOOL_ALLOWLIST).toEqual([
      "whatsapp_reply_to_inbound",
      "whatsapp_send_template"
    ]);
    expect(WHATSAPP_MCP_TOOL_ALLOWLIST).toEqual([
      ...WHATSAPP_MCP_READ_TOOL_ALLOWLIST,
      ...WHATSAPP_MCP_CONVERSATION_READ_TOOL_ALLOWLIST,
      ...WHATSAPP_MCP_WRITE_TOOL_ALLOWLIST
    ]);
  });

  it.each(["reply_to_inbound", "start_conversation", "send_template"] as const)(
    "requires server-owned runtime policy state for messaging action %s",
    (action) => {
      const result = evaluateWhatsAppMcpAction(action);
      expect(result.allowed).toBeNull();
      expect(result.status).toBe("runtime_check_required");
      expect(result.requiredNextStep).toContain("dedicated reply or approved-template tool");
    }
  );

  it.each(WHATSAPP_MCP_WRITE_ACTIONS.filter(
    (action) => !["reply_to_inbound", "start_conversation", "send_template"].includes(action)
  ))("blocks unattended administrative action %s", (action) => {
    const result = evaluateWhatsAppMcpAction(action);
    expect(result.allowed).toBe(false);
    expect(result.status).toBe("blocked");
  });

  it("allows only read-only policy checks", () => {
    expect(evaluateWhatsAppMcpAction("read_policy").allowed).toBe(true);
    expect(evaluateWhatsAppMcpAction("read_connection_status").allowed).toBe(true);
    expect(evaluateWhatsAppMcpAction("read_conversations").allowed).toBe(true);
    expect(evaluateWhatsAppMcpAction("read_conversation_history").allowed).toBe(true);
  });

  it("rejects unknown and path-like tool names", () => {
    expect(() => assertAllowedWhatsAppMcpTool("whatsapp_send_message")).toThrow();
    expect(() => assertAllowedWhatsAppMcpTool("../whatsapp_get_policy")).toThrow();
  });
});
