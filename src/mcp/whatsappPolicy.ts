export const WHATSAPP_POLICY_VERSION = "2026-09-04";

export const WHATSAPP_POLICY_URLS = {
  overview: "https://automatedandco.danienremoto.com/mcp/whatsapp/",
  privacy: "https://automatedandco.danienremoto.com/mcp/whatsapp/privacidad/",
  terms: "https://automatedandco.danienremoto.com/mcp/whatsapp/terminos/",
  deletion: "https://automatedandco.danienremoto.com/mcp/whatsapp/eliminacion-de-datos/",
  support: "https://automatedandco.danienremoto.com/mcp/soporte/"
} as const;

export const WHATSAPP_MCP_TOOL_ALLOWLIST = [
  "whatsapp_get_policy",
  "whatsapp_get_connection_status",
  "whatsapp_evaluate_action"
] as const;

export type WhatsAppMcpToolName = (typeof WHATSAPP_MCP_TOOL_ALLOWLIST)[number];

export const WHATSAPP_MCP_WRITE_ACTIONS = [
  "reply_to_inbound",
  "start_conversation",
  "send_template",
  "bulk_send",
  "create_or_update_template",
  "change_webhook",
  "export_customer_data",
  "delete_customer_data"
] as const;

export type WhatsAppMcpAction =
  | "read_policy"
  | "read_connection_status"
  | (typeof WHATSAPP_MCP_WRITE_ACTIONS)[number];

export type WhatsAppPolicyDecision = {
  allowed: boolean;
  action: WhatsAppMcpAction;
  reasons: string[];
  requiredNextStep?: string;
};

const readOnlyActions = new Set<WhatsAppMcpAction>([
  "read_policy",
  "read_connection_status"
]);

export function assertAllowedWhatsAppMcpTool(toolName: string): asserts toolName is WhatsAppMcpToolName {
  if (!WHATSAPP_MCP_TOOL_ALLOWLIST.includes(toolName as WhatsAppMcpToolName)) {
    throw new Error(`WhatsApp MCP tool is not registered by policy: ${toolName}`);
  }
}

export function evaluateWhatsAppMcpAction(action: WhatsAppMcpAction): WhatsAppPolicyDecision {
  if (readOnlyActions.has(action)) {
    return {
      allowed: true,
      action,
      reasons: ["The action is read-only and returns no message content, customer identity, or provider credential."]
    };
  }

  return {
    allowed: false,
    action,
    reasons: [
      "This MCP release is deny-by-default and does not register WhatsApp write tools.",
      "Outbound messaging requires server-side recipient opt-in, purpose/category consent, opt-out state, service-window or approved-template validation, an approved sender, rate limits, and an auditable human confirmation.",
      "Provider tokens and MCP access tokens may never be accepted from tool arguments or forwarded between services."
    ],
    requiredNextStep: "Use the owner review flow to approve a narrowly scoped write capability; implement and test it as a separate release before registration."
  };
}

export const whatsappPublicPolicy = {
  version: WHATSAPP_POLICY_VERSION,
  urls: WHATSAPP_POLICY_URLS,
  mode: "read-only-deny-by-default",
  rules: [
    "Only people who supplied their phone number and opted in for the relevant message purpose may be contacted.",
    "Opt-out and stop requests block future automated messages immediately.",
    "Free-form replies are limited to the current customer-service window after a user message; outside it, only an approved template for the consented purpose may be considered.",
    "Automation must provide a clear path to a human and pause after escalation or human takeover.",
    "The service must not request full payment-card, financial-account, government-ID, medical, or similarly sensitive identifiers in chat.",
    "Conversation data may not be forwarded between customers or reused beyond the support purpose the person expects.",
    "Illegal, deceptive, discriminatory, harassing, spam, prohibited-vertical, or policy-evasion activity is blocked.",
    "Credentials stay server-side, encrypted, tenant-isolated, audience-bound, and absent from MCP arguments, URLs, logs, and tool results.",
    "Deletion and disconnect requests require an authenticated, auditable workflow and are not exposed as an unattended MCP tool."
  ],
  registeredTools: WHATSAPP_MCP_TOOL_ALLOWLIST,
  unregisteredWriteActions: WHATSAPP_MCP_WRITE_ACTIONS
} as const;
