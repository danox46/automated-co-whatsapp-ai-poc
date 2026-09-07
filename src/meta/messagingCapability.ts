import {
  type DurableConversationNamespace,
  type OutboundDispatchCompletion,
  type OutboundDispatchReservation,
  type OutboundDispatchReservationResult
} from "../mcp/durableConversationStore.js";
import {
  type WhatsAppMessagingCapability,
  type WhatsAppProtectionDecision,
  type WhatsAppApprovedTemplate
} from "../mcp/outboundPolicy.js";
import type { WhatsAppMcpPrincipal } from "../mcp/auth.js";
import { decryptPilotSecret, sha256Base64Url } from "./pilotCrypto.js";
import type { createMetaGraphClient } from "./graphClient.js";
import type { createPilotInstallationRegistry } from "./pilotInstallationStore.js";

export type WhatsAppPolicyDirectory = {
  resolve(principal: WhatsAppMcpPrincipal, conversationRef: string): Promise<{
    approvedTemplates: readonly WhatsAppApprovedTemplate[];
    consentedTemplateCategories: ReadonlySet<string>;
    consentedTemplatePurposes: ReadonlySet<string>;
  }>;
};

const denyTemplateDirectory: WhatsAppPolicyDirectory = {
  resolve: async () => ({
    approvedTemplates: [],
    consentedTemplateCategories: new Set(),
    consentedTemplatePurposes: new Set()
  })
};

export function createMetaMessagingCapability(input: {
  conversations: DurableConversationNamespace;
  registry: ReturnType<typeof createPilotInstallationRegistry>;
  graph: ReturnType<typeof createMetaGraphClient>;
  encryptionKey: string;
  policyDirectory?: WhatsAppPolicyDirectory;
  recipientAllowed?: (tenantId: string, recipient: string) => boolean | Promise<boolean>;
  now?: () => Date;
}): WhatsAppMessagingCapability {
  const policyDirectory = input.policyDirectory ?? denyTemplateDirectory;
  const now = input.now ?? (() => new Date());

  return {
    guaranteesDurableIdempotency: true,
    now,
    async resolveConversation(principal, conversationRef) {
      const stub = input.conversations.getByName(principal.tenantId);
      await stub.initializeTenant(principal.tenantId);
      const [state, policy] = await Promise.all([
        stub.getConversationEnforcementState(conversationRef),
        policyDirectory.resolve(principal, conversationRef)
      ]);
      if (!state) return null;
      return {
        canonicalConversationRef: state.conversationRef,
        providerParticipantRef: state.providerParticipantRef,
        policyRevision: state.policyRevision,
        lastVerifiedUserInboundAt: state.lastVerifiedUserInboundAt ?? null,
        recipientOptedOut: state.recipientOptedOut,
        automationPaused: state.automationPaused,
        consentedTemplateCategories: policy.consentedTemplateCategories,
        consentedTemplatePurposes: policy.consentedTemplatePurposes,
        approvedTemplates: policy.approvedTemplates
      };
    },
    async validateOutboundContent({ kind, text, variables }) {
      if (kind === "free_form_reply") {
        if (!text?.trim()) return { allowed: false, message: "A reply cannot be empty." };
        if (new TextEncoder().encode(text).byteLength > 4096) {
          return { allowed: false, message: "The reply exceeds WhatsApp's 4,096-byte text limit." };
        }
        if (/\u0000/u.test(text)) return { allowed: false, message: "The reply contains an unsupported control character." };
      }
      if (kind === "approved_template" && (variables?.length ?? 0) > 20) {
        return { allowed: false, message: "The approved pilot template accepts at most 20 variables." };
      }
      return { allowed: true };
    },
    async dispatchReplyWithPolicy(dispatch) {
      if (input.recipientAllowed && (
        !dispatch.conversation.providerParticipantRef ||
        !await input.recipientAllowed(dispatch.principal.tenantId, dispatch.conversation.providerParticipantRef)
      )) return sandboxRecipientBlock();
      const fingerprint = await sha256Base64Url(JSON.stringify({
        kind: "free_form_reply",
        conversationRef: dispatch.conversation.canonicalConversationRef,
        text: dispatch.text
      }));
      const reservation = await reserve(input.conversations, dispatch.principal, {
        conversationRef: dispatch.conversation.canonicalConversationRef,
        kind: "free_form_reply",
        idempotencyKey: dispatch.idempotencyKey,
        requestFingerprint: fingerprint,
        expectedPolicyRevision: dispatch.expectedPolicyRevision,
        now: now().toISOString(),
        notAfter: dispatch.notAfter
      });
      if (reservation.status === "blocked") return reservationBlock(reservation);
      if (reservation.status === "duplicate") {
        return { messageRef: reservation.messageRef, status: reservation.providerStatus };
      }
      const installation = await connectedInstallation(input.registry, dispatch.principal.tenantId);
      if (!installation || installation.phoneNumberId !== reservation.providerAccountRef) return stateChanged();
      const accessToken = await decryptPilotSecret(installation.encryptedAccessToken, input.encryptionKey);
      const result = await input.graph.sendText(
        accessToken,
        installation.phoneNumberId,
        reservation.providerParticipantRef,
        dispatch.text
      );
      await complete(input.conversations, dispatch.principal, {
        idempotencyKey: dispatch.idempotencyKey,
        requestFingerprint: fingerprint,
        conversationRef: dispatch.conversation.canonicalConversationRef,
        providerAccountRef: reservation.providerAccountRef,
        providerParticipantRef: reservation.providerParticipantRef,
        messageRef: result.messageRef,
        providerStatus: result.status,
        kind: "text",
        text: dispatch.text,
        occurredAt: now().toISOString()
      });
      return result;
    },
    async dispatchTemplateWithPolicy(dispatch) {
      if (input.recipientAllowed && (
        !dispatch.conversation.providerParticipantRef ||
        !await input.recipientAllowed(dispatch.principal.tenantId, dispatch.conversation.providerParticipantRef)
      )) return sandboxRecipientBlock();
      const template = dispatch.conversation.approvedTemplates.find((candidate) =>
        candidate.enabled && candidate.name === dispatch.templateName
      );
      if (!template) return templateUnavailable();
      const fingerprint = await sha256Base64Url(JSON.stringify({
        kind: "approved_template",
        conversationRef: dispatch.conversation.canonicalConversationRef,
        templateName: dispatch.templateName,
        variables: dispatch.variables
      }));
      const reservation = await reserve(input.conversations, dispatch.principal, {
        conversationRef: dispatch.conversation.canonicalConversationRef,
        kind: "approved_template",
        idempotencyKey: dispatch.idempotencyKey,
        requestFingerprint: fingerprint,
        expectedPolicyRevision: dispatch.expectedPolicyRevision,
        now: now().toISOString()
      });
      if (reservation.status === "blocked") return reservationBlock(reservation);
      if (reservation.status === "duplicate") {
        return { messageRef: reservation.messageRef, status: reservation.providerStatus };
      }
      const installation = await connectedInstallation(input.registry, dispatch.principal.tenantId);
      if (!installation || installation.phoneNumberId !== reservation.providerAccountRef) return stateChanged();
      const accessToken = await decryptPilotSecret(installation.encryptedAccessToken, input.encryptionKey);
      const result = await input.graph.sendTemplate(
        accessToken,
        installation.phoneNumberId,
        reservation.providerParticipantRef,
        dispatch.templateName,
        template.languageCode ?? "en_US",
        dispatch.variables
      );
      await complete(input.conversations, dispatch.principal, {
        idempotencyKey: dispatch.idempotencyKey,
        requestFingerprint: fingerprint,
        conversationRef: dispatch.conversation.canonicalConversationRef,
        providerAccountRef: reservation.providerAccountRef,
        providerParticipantRef: reservation.providerParticipantRef,
        messageRef: result.messageRef,
        providerStatus: result.status,
        kind: "template",
        templateName: dispatch.templateName,
        occurredAt: now().toISOString()
      });
      return result;
    }
  };
}

export function createDurableWhatsAppPolicyDirectory(
  conversations: DurableConversationNamespace
): WhatsAppPolicyDirectory {
  return {
    async resolve(principal, conversationRef) {
      const stub = conversations.getByName(principal.tenantId);
      await stub.initializeTenant(principal.tenantId);
      const policy = await stub.getOutboundPolicy(conversationRef);
      return {
        approvedTemplates: policy.approvedTemplates,
        consentedTemplateCategories: new Set(policy.consentedTemplateCategories),
        consentedTemplatePurposes: new Set(policy.consentedTemplatePurposes)
      };
    }
  };
}

async function reserve(
  conversations: DurableConversationNamespace,
  principal: WhatsAppMcpPrincipal,
  reservation: OutboundDispatchReservation
) {
  const stub = conversations.getByName(principal.tenantId);
  await stub.initializeTenant(principal.tenantId);
  return stub.reserveOutboundDispatch(reservation);
}

async function complete(
  conversations: DurableConversationNamespace,
  principal: WhatsAppMcpPrincipal,
  completion: OutboundDispatchCompletion
) {
  const stub = conversations.getByName(principal.tenantId);
  await stub.initializeTenant(principal.tenantId);
  await stub.completeOutboundDispatch(completion);
}

async function connectedInstallation(
  registry: ReturnType<typeof createPilotInstallationRegistry>,
  tenantId: string
) {
  const installation = await registry.getInstallation(tenantId);
  return installation?.status === "connected" ? installation : null;
}

function reservationBlock(result: Extract<OutboundDispatchReservationResult, { status: "blocked" }>): WhatsAppProtectionDecision {
  if (result.reason === "window_closed") {
    return protection(
      "WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED",
      "WhatsApp's 24-hour customer-service window closed before dispatch. Nothing was sent; use an approved template or wait for the customer to message again.",
      { suggestedTool: "whatsapp_send_template", requiredAction: "approved_template_required" }
    );
  }
  if (result.reason === "recipient_opted_out") {
    return protection("WHATSAPP_RECIPIENT_OPTED_OUT", "This recipient opted out. Nothing was sent.");
  }
  if (result.reason === "automation_paused") {
    return protection("WHATSAPP_AUTOMATION_PAUSED", "Automation is paused for this conversation. Nothing was sent.");
  }
  if (result.reason === "in_progress") {
    return protection(
      "WHATSAPP_SEND_IN_PROGRESS",
      "A send with this idempotency key is already being reconciled. Nothing was sent again.",
      { retryable: true }
    );
  }
  return stateChanged();
}

function stateChanged(): WhatsAppProtectionDecision {
  return protection(
    "WHATSAPP_CONVERSATION_STATE_CHANGED",
    "The provider binding or conversation policy changed before dispatch. Nothing was sent; resolve the latest conversation state and retry.",
    { retryable: true }
  );
}

function templateUnavailable(): WhatsAppProtectionDecision {
  return protection(
    "WHATSAPP_TEMPLATE_NOT_APPROVED",
    "That template is no longer approved for this tenant. Nothing was sent."
  );
}

function sandboxRecipientBlock(): WhatsAppProtectionDecision {
  return protection(
    "WHATSAPP_SANDBOX_RECIPIENT_NOT_ALLOWED",
    "This development tenant can send only to a server-approved Meta sandbox recipient. Nothing was sent."
  );
}

function protection(
  code: WhatsAppProtectionDecision["code"],
  message: string,
  extra: Partial<WhatsAppProtectionDecision> = {}
): WhatsAppProtectionDecision {
  return {
    allowed: false,
    code,
    message,
    retryable: false,
    protectedBy: "whatsapp-business-policy",
    requiredAction: "human_review_required",
    ...extra
  };
}
