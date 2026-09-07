import type { WhatsAppMcpPrincipal } from "./auth.js";

export const WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WHATSAPP_SEND_SCOPE = "whatsapp.messages.send";

export type WhatsAppApprovedTemplate = {
  name: string;
  category: string;
  purpose: string;
  languageCode?: string;
  enabled: boolean;
};

export type ResolvedWhatsAppConversation = {
  canonicalConversationRef: string;
  policyRevision: string;
  lastVerifiedUserInboundAt: string | null;
  recipientOptedOut: boolean;
  automationPaused: boolean;
  consentedTemplateCategories: ReadonlySet<string>;
  consentedTemplatePurposes: ReadonlySet<string>;
  approvedTemplates: readonly WhatsAppApprovedTemplate[];
};

export type WhatsAppProtectionCode =
  | "WHATSAPP_SEND_SCOPE_REQUIRED"
  | "WHATSAPP_CONVERSATION_NOT_AVAILABLE"
  | "WHATSAPP_CONVERSATION_STATE_CHANGED"
  | "WHATSAPP_SEND_IN_PROGRESS"
  | "WHATSAPP_RECIPIENT_OPTED_OUT"
  | "WHATSAPP_AUTOMATION_PAUSED"
  | "WHATSAPP_NO_VERIFIED_USER_MESSAGE"
  | "WHATSAPP_INVALID_INBOUND_TIMESTAMP"
  | "WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED"
  | "WHATSAPP_TEMPLATE_NOT_APPROVED"
  | "WHATSAPP_TEMPLATE_CONSENT_REQUIRED"
  | "WHATSAPP_CONTENT_POLICY_BLOCKED";

export type WhatsAppProtectionDecision = {
  allowed: false;
  code: WhatsAppProtectionCode;
  message: string;
  retryable: boolean;
  protectedBy: "whatsapp-business-policy" | "mcp-authorization" | "business-safety-policy";
  requiredAction?: "approved_template_required" | "customer_message_required" | "human_review_required";
  suggestedTool?: "whatsapp_send_template";
  windowClosedAt?: string;
};

export type WhatsAppAllowedDecision = {
  allowed: true;
  code: "WHATSAPP_ACTION_ALLOWED";
  message: string;
};

export type WhatsAppOutboundDecision = WhatsAppProtectionDecision | WhatsAppAllowedDecision;

export type WhatsAppContentDecision =
  | { allowed: true }
  | { allowed: false; message: string };

export type WhatsAppProviderResult = {
  messageRef: string;
  status: "accepted" | "queued" | "sent";
};

export type WhatsAppProviderDispatchResult = WhatsAppProviderResult | WhatsAppProtectionDecision;

export type WhatsAppMessagingCapability = {
  guaranteesDurableIdempotency: boolean;
  resolveConversation(
    principal: WhatsAppMcpPrincipal,
    conversationRef: string
  ): Promise<ResolvedWhatsAppConversation | null>;
  validateOutboundContent(input: {
    principal: WhatsAppMcpPrincipal;
    conversation: ResolvedWhatsAppConversation;
    kind: "free_form_reply" | "approved_template";
    text?: string;
    templateName?: string;
    variables?: readonly string[];
  }): Promise<WhatsAppContentDecision>;
  dispatchReplyWithPolicy(input: {
    principal: WhatsAppMcpPrincipal;
    conversation: ResolvedWhatsAppConversation;
    text: string;
    idempotencyKey: string;
    notAfter: string;
    expectedPolicyRevision: string;
  }): Promise<WhatsAppProviderDispatchResult>;
  dispatchTemplateWithPolicy(input: {
    principal: WhatsAppMcpPrincipal;
    conversation: ResolvedWhatsAppConversation;
    templateName: string;
    variables: readonly string[];
    idempotencyKey: string;
    expectedPolicyRevision: string;
  }): Promise<WhatsAppProviderDispatchResult>;
  now?: () => Date;
};

export type WhatsAppOutboundResult =
  | ({ ok: true } & WhatsAppProviderResult)
  | { ok: false; error: WhatsAppProtectionDecision };

function block(
  code: WhatsAppProtectionCode,
  message: string,
  options: Partial<Omit<WhatsAppProtectionDecision, "allowed" | "code" | "message">> = {}
): WhatsAppProtectionDecision {
  return {
    allowed: false,
    code,
    message,
    retryable: false,
    protectedBy: "whatsapp-business-policy",
    ...options
  };
}

function commonConversationBlock(
  conversation: ResolvedWhatsAppConversation
): WhatsAppProtectionDecision | null {
  if (conversation.recipientOptedOut) {
    return block(
      "WHATSAPP_RECIPIENT_OPTED_OUT",
      "This recipient opted out. The message was blocked to respect their choice.",
      { requiredAction: "human_review_required" }
    );
  }
  if (conversation.automationPaused) {
    return block(
      "WHATSAPP_AUTOMATION_PAUSED",
      "Automation is paused because this conversation is under human control. Resume automation explicitly after the handoff is complete.",
      { requiredAction: "human_review_required" }
    );
  }
  return null;
}

export function evaluateFreeFormReply(
  conversation: ResolvedWhatsAppConversation,
  now: Date
): WhatsAppOutboundDecision {
  const commonBlock = commonConversationBlock(conversation);
  if (commonBlock) return commonBlock;

  if (!conversation.lastVerifiedUserInboundAt) {
    return block(
      "WHATSAPP_NO_VERIFIED_USER_MESSAGE",
      "WhatsApp allows a free-form reply only after a verified customer message. Use an approved template to start or reopen the conversation.",
      {
        requiredAction: "approved_template_required",
        suggestedTool: "whatsapp_send_template"
      }
    );
  }

  const inboundAt = new Date(conversation.lastVerifiedUserInboundAt);
  if (!Number.isFinite(inboundAt.getTime()) || inboundAt.getTime() > now.getTime()) {
    return block(
      "WHATSAPP_INVALID_INBOUND_TIMESTAMP",
      "The verified inbound-message time is unavailable or inconsistent. The reply was paused so the service window can be checked safely.",
      { requiredAction: "human_review_required" }
    );
  }

  const windowClosedAt = new Date(inboundAt.getTime() + WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS);
  if (now.getTime() >= windowClosedAt.getTime()) {
    return block(
      "WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED",
      `WhatsApp's 24-hour customer-service window closed at ${windowClosedAt.toISOString()}. This free-form reply was blocked to protect the account—not because the MCP lacks capability. Send an approved template with whatsapp_send_template, or wait for the customer to message again.`,
      {
        requiredAction: "approved_template_required",
        suggestedTool: "whatsapp_send_template",
        windowClosedAt: windowClosedAt.toISOString()
      }
    );
  }

  return {
    allowed: true,
    code: "WHATSAPP_ACTION_ALLOWED",
    message: "The verified customer-service window is open, so this free-form reply is allowed."
  };
}

export function evaluateTemplateSend(
  conversation: ResolvedWhatsAppConversation,
  templateName: string
): WhatsAppOutboundDecision {
  const commonBlock = commonConversationBlock(conversation);
  if (commonBlock) return commonBlock;

  const template = conversation.approvedTemplates.find(
    (candidate) => candidate.enabled && candidate.name === templateName
  );
  if (!template) {
    return block(
      "WHATSAPP_TEMPLATE_NOT_APPROVED",
      "That template is not currently approved and enabled for this WhatsApp account. Choose an approved template; the MCP will not silently replace or alter the message.",
      { requiredAction: "human_review_required" }
    );
  }

  if (!conversation.consentedTemplateCategories.has(template.category)) {
    return block(
      "WHATSAPP_TEMPLATE_CONSENT_REQUIRED",
      `The recipient has not opted in to the ${template.category} message category. Obtain the required consent or choose a template for a consented category.`,
      { requiredAction: "human_review_required" }
    );
  }

  if (!conversation.consentedTemplatePurposes.has(template.purpose)) {
    return block(
      "WHATSAPP_TEMPLATE_CONSENT_REQUIRED",
      `The recipient has not opted in to the ${template.purpose} message purpose. Obtain the required consent or choose a template for a consented purpose.`,
      { requiredAction: "human_review_required" }
    );
  }

  return {
    allowed: true,
    code: "WHATSAPP_ACTION_ALLOWED",
    message: "The approved template and consent category are valid for this recipient."
  };
}

function scopeBlock(): WhatsAppProtectionDecision {
  return block(
    "WHATSAPP_SEND_SCOPE_REQUIRED",
    "This MCP connection has read access but was not granted WhatsApp sending permission. Reconnect and approve the whatsapp.messages.send scope to use messaging tools.",
    {
      protectedBy: "mcp-authorization",
      requiredAction: "human_review_required"
    }
  );
}

function conversationBlock(): WhatsAppProtectionDecision {
  return block(
    "WHATSAPP_CONVERSATION_NOT_AVAILABLE",
    "The conversation is unavailable to this authenticated tenant. Check the conversation reference and account connection.",
    {
      protectedBy: "mcp-authorization",
      requiredAction: "human_review_required"
    }
  );
}

function conversationChangedBlock(): WhatsAppProtectionDecision {
  return block(
    "WHATSAPP_CONVERSATION_STATE_CHANGED",
    "The conversation changed while the message was being prepared. Nothing was sent; retry so the latest recipient and policy state can be evaluated.",
    {
      protectedBy: "mcp-authorization",
      retryable: true
    }
  );
}

function contentBlock(message: string): WhatsAppProtectionDecision {
  return block("WHATSAPP_CONTENT_POLICY_BLOCKED", message, {
    protectedBy: "business-safety-policy",
    requiredAction: "human_review_required"
  });
}

async function resolveForDispatch(
  capability: WhatsAppMessagingCapability,
  principal: WhatsAppMcpPrincipal,
  conversationRef: string
): Promise<ResolvedWhatsAppConversation | WhatsAppProtectionDecision> {
  if (!principal.scopes.has(WHATSAPP_SEND_SCOPE)) return scopeBlock();
  const conversation = await capability.resolveConversation(principal, conversationRef);
  return conversation ?? conversationBlock();
}

export async function dispatchFreeFormReply(
  capability: WhatsAppMessagingCapability,
  principal: WhatsAppMcpPrincipal,
  input: { conversationRef: string; text: string; idempotencyKey: string }
): Promise<WhatsAppOutboundResult> {
  const firstResolution = await resolveForDispatch(capability, principal, input.conversationRef);
  if ("allowed" in firstResolution) return { ok: false, error: firstResolution };

  const firstDecision = evaluateFreeFormReply(firstResolution, (capability.now ?? (() => new Date()))());
  if (!firstDecision.allowed) return { ok: false, error: firstDecision };

  const finalResolution = await resolveForDispatch(capability, principal, input.conversationRef);
  if ("allowed" in finalResolution) return { ok: false, error: finalResolution };
  if (finalResolution.canonicalConversationRef !== firstResolution.canonicalConversationRef) {
    return { ok: false, error: conversationChangedBlock() };
  }
  const finalDecision = evaluateFreeFormReply(finalResolution, (capability.now ?? (() => new Date()))());
  if (!finalDecision.allowed) return { ok: false, error: finalDecision };

  const contentDecision = await capability.validateOutboundContent({
    principal,
    conversation: finalResolution,
    kind: "free_form_reply",
    text: input.text
  });
  if (!contentDecision.allowed) return { ok: false, error: contentBlock(contentDecision.message) };

  const dispatchDecision = evaluateFreeFormReply(finalResolution, (capability.now ?? (() => new Date()))());
  if (!dispatchDecision.allowed) return { ok: false, error: dispatchDecision };
  const notAfter = new Date(
    new Date(finalResolution.lastVerifiedUserInboundAt as string).getTime() + WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS
  ).toISOString();

  const providerResult = await capability.dispatchReplyWithPolicy({
      principal,
      conversation: finalResolution,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      notAfter,
      expectedPolicyRevision: finalResolution.policyRevision
    });
  return "allowed" in providerResult
    ? { ok: false, error: providerResult }
    : { ok: true, ...providerResult };
}

export async function dispatchApprovedTemplate(
  capability: WhatsAppMessagingCapability,
  principal: WhatsAppMcpPrincipal,
  input: {
    conversationRef: string;
    templateName: string;
    variables: readonly string[];
    idempotencyKey: string;
  }
): Promise<WhatsAppOutboundResult> {
  const firstResolution = await resolveForDispatch(capability, principal, input.conversationRef);
  if ("allowed" in firstResolution) return { ok: false, error: firstResolution };

  const firstDecision = evaluateTemplateSend(firstResolution, input.templateName);
  if (!firstDecision.allowed) return { ok: false, error: firstDecision };

  const finalResolution = await resolveForDispatch(capability, principal, input.conversationRef);
  if ("allowed" in finalResolution) return { ok: false, error: finalResolution };
  if (finalResolution.canonicalConversationRef !== firstResolution.canonicalConversationRef) {
    return { ok: false, error: conversationChangedBlock() };
  }
  const finalDecision = evaluateTemplateSend(finalResolution, input.templateName);
  if (!finalDecision.allowed) return { ok: false, error: finalDecision };

  const contentDecision = await capability.validateOutboundContent({
    principal,
    conversation: finalResolution,
    kind: "approved_template",
    templateName: input.templateName,
    variables: input.variables
  });
  if (!contentDecision.allowed) return { ok: false, error: contentBlock(contentDecision.message) };

  const providerResult = await capability.dispatchTemplateWithPolicy({
      principal,
      conversation: finalResolution,
      templateName: input.templateName,
      variables: input.variables,
      idempotencyKey: input.idempotencyKey,
      expectedPolicyRevision: finalResolution.policyRevision
    });
  return "allowed" in providerResult
    ? { ok: false, error: providerResult }
    : { ok: true, ...providerResult };
}
