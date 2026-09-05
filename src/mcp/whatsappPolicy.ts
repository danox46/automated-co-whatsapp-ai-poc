export const WHATSAPP_POLICY_VERSION = "2026-09-05";

export const WHATSAPP_POLICY_URLS = {
  overview: "https://automatedandco.danienremoto.com/mcp/whatsapp/",
  privacy: "https://automatedandco.danienremoto.com/mcp/whatsapp/privacidad/",
  terms: "https://automatedandco.danienremoto.com/mcp/whatsapp/terminos/",
  deletion: "https://automatedandco.danienremoto.com/mcp/whatsapp/eliminacion-de-datos/",
  support: "https://automatedandco.danienremoto.com/mcp/soporte/"
} as const;

export const WHATSAPP_MCP_READ_TOOL_ALLOWLIST = [
  "whatsapp_get_policy",
  "whatsapp_get_connection_status",
  "whatsapp_evaluate_action"
] as const;

export const WHATSAPP_MCP_WRITE_TOOL_ALLOWLIST = [
  "whatsapp_reply_to_inbound",
  "whatsapp_send_template"
] as const;

export const WHATSAPP_MCP_TOOL_ALLOWLIST = [
  ...WHATSAPP_MCP_READ_TOOL_ALLOWLIST,
  ...WHATSAPP_MCP_WRITE_TOOL_ALLOWLIST
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
  allowed: boolean | null;
  action: WhatsAppMcpAction;
  status: "allowed" | "blocked" | "runtime_check_required";
  code: string;
  message: string;
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
      status: "allowed",
      code: "ALLOWED_READ_ONLY",
      message: "This read-only action is available.",
      reasons: ["The action is read-only and returns no message content, customer identity, or provider credential."]
    };
  }

  if (action === "reply_to_inbound" || action === "start_conversation" || action === "send_template") {
    return {
      allowed: null,
      action,
      status: "runtime_check_required",
      code: "WHATSAPP_RUNTIME_POLICY_CHECK_REQUIRED",
      message: "This messaging action can be available after the MCP resolves the conversation, consent, template, and service-window state on the server.",
      reasons: [
        "A caller cannot authoritatively claim the recipient, sender, opt-in, opt-out, last inbound time, or template approval state.",
        "The final decision is made immediately before provider dispatch using server-owned facts."
      ],
      requiredNextStep: "Call the dedicated reply or approved-template tool. It will either send compliantly or return a specific protective error and safe alternative."
    };
  }

  return {
    allowed: false,
    action,
    status: "blocked",
    code: "WHATSAPP_UNATTENDED_ADMIN_ACTION_BLOCKED",
    message: "This unattended administrative action is not exposed through the WhatsApp MCP.",
    reasons: [
      "Bulk messaging, template mutation, webhook changes, exports, and deletions require dedicated authenticated workflows with narrower authorization and audit controls.",
      "Provider tokens and MCP access tokens may never be accepted from tool arguments or forwarded between services."
    ],
    requiredNextStep: "Use the corresponding authenticated administrative workflow rather than an unattended MCP tool."
  };
}

export const whatsappPublicPolicy = {
  version: WHATSAPP_POLICY_VERSION,
  urls: WHATSAPP_POLICY_URLS,
  mode: "capability-maximizing-policy-enforced",
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
  alwaysRegisteredTools: WHATSAPP_MCP_READ_TOOL_ALLOWLIST,
  providerBackedTools: WHATSAPP_MCP_WRITE_TOOL_ALLOWLIST,
  runtimePolicyActions: ["reply_to_inbound", "start_conversation", "send_template"],
  administrativeActionsNotExposed: [
    "bulk_send",
    "create_or_update_template",
    "change_webhook",
    "export_customer_data",
    "delete_customer_data"
  ]
} as const;
