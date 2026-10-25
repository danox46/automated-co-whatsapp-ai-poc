import type { WhatsAppMcpPrincipal } from "../mcp/auth.js";
import type { DurableConversationNamespace } from "../mcp/durableConversationStore.js";
import { evaluateFreeFormReply, WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS } from "../mcp/outboundPolicy.js";
import type { createMetaGraphClient } from "./graphClient.js";
import type { createPilotInstallationRegistry } from "./pilotInstallationStore.js";
import { decryptPilotSecret, sha256Base64Url } from "./pilotCrypto.js";
import { flowToken, type SandboxFlowKind } from "./flowResponses.js";
import type { WhatsAppSandboxConfig } from "./sandboxConfig.js";
import { providerRejectionDecision, recordDefiniteProviderRejection } from "./providerRejection.js";

export type DraftFlowSendInput = { conversationRef: string; flowType: SandboxFlowKind; idempotencyKey: string; text?: string };
export type DraftFlowSendResult =
  | { ok: true; messageRef: string; status: "accepted" | "queued" | "sent"; flowType: SandboxFlowKind }
  | { ok: false; error: { code: string; message: string; retryable: boolean; providerErrorCode?: string; providerHttpStatus?: number } };
export type SandboxFlowMessaging = { guaranteesDurableIdempotency: true; send(principal: WhatsAppMcpPrincipal, input: DraftFlowSendInput): Promise<DraftFlowSendResult> };

const forms = {
  visit: { name: "Sol Sandbox - Agendar visita", screen: "VISIT_SCHEDULE", text: "Completa el formulario de prueba para coordinar tu visita.", cta: "Agendar visita" },
  wholesale: { name: "Sol Sandbox - Perfil mayorista", screen: "WHOLESALE_PROFILE", text: "Completa el formulario de prueba para compartir tu perfil mayorista.", cta: "Perfil mayorista" }
} as const;

/** App-owned draft tests only. Callers cannot supply recipients, IDs or Graph bodies. */
export function createSandboxFlowMessaging(input: {
  sandbox: WhatsAppSandboxConfig;
  flowIds: Partial<Record<SandboxFlowKind, string>>;
  conversations: DurableConversationNamespace;
  registry: ReturnType<typeof createPilotInstallationRegistry>;
  graph: ReturnType<typeof createMetaGraphClient>;
  encryptionKey: string;
  correlationSecret: string;
  now?: () => Date;
}): SandboxFlowMessaging {
  const now = input.now ?? (() => new Date());
  return { guaranteesDurableIdempotency: true, async send(principal, args) {
    if (!principal.scopes.has("whatsapp.messages.send")) return failure("WHATSAPP_SEND_SCOPE_REQUIRED", "Sending a Flow requires the existing message-write scope.");
    const form = forms[args.flowType];
    const flowId = input.flowIds[args.flowType];
    if (principal.tenantId !== input.sandbox.tenantId || !form || !flowId || !/^\d{3,32}$/u.test(flowId)) return failure("WHATSAPP_FLOW_NOT_AVAILABLE", "That draft Flow is not configured for this sandbox.");
    if (!/^conv_[A-Za-z0-9_-]{32}$/u.test(args.conversationRef) || !/^[A-Za-z0-9._:-]{8,128}$/u.test(args.idempotencyKey)) return failure("WHATSAPP_FLOW_INPUT_INVALID", "Use the original conversation reference and an 8–128 character intent key.");
    if (args.text !== undefined && (typeof args.text !== "string" || !args.text.trim() || args.text.length > 1024 || args.text.includes("\0"))) return failure("WHATSAPP_FLOW_INPUT_INVALID", "A Flow introduction must contain 1–1024 characters and no NUL characters.");
    const text = args.text?.trim() ?? form.text;
    const stub = input.conversations.getByName(principal.tenantId);
    await stub.initializeTenant(principal.tenantId);
    const fingerprint = await sha256Base64Url(JSON.stringify({ kind: "draft_flow", conversationRef: args.conversationRef, flowType: args.flowType, flowId, ...form, text }));
    const previous = await stub.getOutboundDispatchResult({ idempotencyKey: args.idempotencyKey, requestFingerprint: fingerprint });
    if (previous?.status === "duplicate") return { ok: true, messageRef: previous.messageRef, status: previous.providerStatus, flowType: args.flowType };
    if (previous?.status === "blocked" && previous.reason === "provider_rejected") return flowRejection(previous.providerErrorCode, previous.providerHttpStatus);
    if (previous) return failure(previous.reason === "in_progress" ? "WHATSAPP_SEND_IN_PROGRESS" : "WHATSAPP_CONVERSATION_STATE_CHANGED", "The original intent is reserved or differs from this request. Reconcile it; do not create a replacement key.");
    const state = await stub.getConversationEnforcementState(args.conversationRef);
    if (!state || state.providerAccountRef !== input.sandbox.phoneNumberId) return failure("WHATSAPP_CONVERSATION_NOT_AVAILABLE", "This conversation is not bound to the configured sandbox sender.");
    if (!input.sandbox.allowedRecipients.includes(state.providerParticipantRef)) return failure("WHATSAPP_SANDBOX_RECIPIENT_NOT_ALLOWED", "Draft tests are restricted to the configured sandbox recipients.");
    const decision = evaluateFreeFormReply({ canonicalConversationRef: state.conversationRef, policyRevision: state.policyRevision,
      lastVerifiedUserInboundAt: state.lastVerifiedUserInboundAt ?? null, recipientOptedOut: state.recipientOptedOut, automationPaused: state.automationPaused,
      consentedTemplateCategories: new Set(), consentedTemplatePurposes: new Set(), approvedTemplates: [] }, now());
    if (!decision.allowed) return { ok: false, error: decision };
    const installation = await input.registry.getInstallation(principal.tenantId);
    if (!installation || installation.status !== "connected" || installation.wabaId !== input.sandbox.wabaId || installation.phoneNumberId !== input.sandbox.phoneNumberId) return failure("WHATSAPP_CONVERSATION_STATE_CHANGED", "The sandbox installation is not currently connected to its expected WABA and sender.");
    let accessToken: string;
    try {
      accessToken = await decryptPilotSecret(installation.encryptedAccessToken, input.encryptionKey);
      const available = await input.graph.listFlows(accessToken, input.sandbox.wabaId);
      if (!available.some(f => f.id === flowId && f.name === form.name && f.status === "DRAFT")) return failure("WHATSAPP_FLOW_NOT_AVAILABLE", "The selected draft is unavailable or no longer matches this sandbox. Nothing was sent.");
    } catch { return failure("WHATSAPP_FLOW_LOOKUP_FAILED", "The draft could not be verified. Nothing was sent; retry the same original intent after the read issue is resolved.", true); }
    const notAfter = new Date(Date.parse(state.lastVerifiedUserInboundAt!) + WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS).toISOString();
    const token = await flowToken(input.correlationSecret, principal.tenantId, args.conversationRef, args.idempotencyKey);
    const tokenHash = await sha256Base64Url(token);
    const createdAt = now().toISOString();
    const reservation = await stub.reserveOutboundDispatch({ conversationRef: args.conversationRef, kind: "free_form_reply", idempotencyKey: args.idempotencyKey,
      requestFingerprint: fingerprint, expectedPolicyRevision: state.policyRevision, expectedProviderAccountRef: input.sandbox.phoneNumberId, now: createdAt, notAfter });
    if (reservation.status === "duplicate") return { ok: true, messageRef: reservation.messageRef, status: reservation.providerStatus, flowType: args.flowType };
    if (reservation.status === "blocked") {
      if (reservation.reason === "provider_rejected") return flowRejection(reservation.providerErrorCode, reservation.providerHttpStatus);
      if (reservation.reason === "window_closed") return failure("WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED", "WhatsApp's 24-hour customer-service window closed before dispatch. This protects the account; wait for a new customer message or use an approved template.");
      if (reservation.reason === "recipient_opted_out") return failure("WHATSAPP_RECIPIENT_OPTED_OUT", "The recipient opted out before dispatch. Nothing was sent.");
      if (reservation.reason === "automation_paused") return failure("WHATSAPP_AUTOMATION_PAUSED", "Human control paused this conversation before dispatch. Nothing was sent.");
      return failure(reservation.reason === "in_progress" ? "WHATSAPP_SEND_IN_PROGRESS" : "WHATSAPP_CONVERSATION_STATE_CHANGED", "Conversation policy changed or the original intent is already reserved. Nothing was sent again; inspect its original receipt.");
    }
    try {
      await stub.registerFlowLaunch({ tokenHash, conversationRef: args.conversationRef, kind: args.flowType, idempotencyKey: args.idempotencyKey,
        requestFingerprint: fingerprint, createdAt, expiresAt: new Date(Date.parse(createdAt) + 7 * 86400000).toISOString() });
    } catch {
      await stub.cancelUnsentOutboundDispatch({ idempotencyKey: args.idempotencyKey, requestFingerprint: fingerprint });
      return failure("WHATSAPP_FLOW_CORRELATION_FAILED", "The draft's answer correlation could not be stored. No provider send was initiated.");
    }
    if (now().toISOString() >= notAfter) {
      await stub.cancelUnsentOutboundDispatch({ idempotencyKey: args.idempotencyKey, requestFingerprint: fingerprint });
      return failure("WHATSAPP_CUSTOMER_SERVICE_WINDOW_CLOSED", "The 24-hour window closed before dispatch. No provider send was initiated.");
    }
    try {
      const result = await input.graph.sendDraftFlow(accessToken, reservation.providerAccountRef, reservation.providerParticipantRef, { flowId, screen: form.screen, token, text, cta: form.cta });
      await stub.completeOutboundDispatch({ idempotencyKey: args.idempotencyKey, requestFingerprint: fingerprint, conversationRef: args.conversationRef,
        providerAccountRef: reservation.providerAccountRef, providerParticipantRef: reservation.providerParticipantRef, messageRef: result.messageRef,
        providerStatus: result.status, kind: "interactive", text, occurredAt: now().toISOString() });
      await stub.bindFlowLaunchMessage({ tokenHash, conversationRef: args.conversationRef, messageRef: result.messageRef });
      return { ok: true, ...result, flowType: args.flowType };
    } catch (error) {
      const rejection = await recordDefiniteProviderRejection(stub, { idempotencyKey: args.idempotencyKey, requestFingerprint: fingerprint }, error, now().toISOString());
      if (rejection) return flowRejection(rejection.providerErrorCode!, rejection.providerHttpStatus!);
      return failure("WHATSAPP_FLOW_OUTCOME_UNKNOWN", "The original draft send requires reconciliation. It was not resubmitted; keep its original intent key and inspect history.");
    }
  } };
}

function failure(code: string, message: string, retryable = false): DraftFlowSendResult {
  return { ok: false, error: { code, message, retryable } };
}

function flowRejection(providerErrorCode: string, providerHttpStatus: number): DraftFlowSendResult {
  const decision = providerRejectionDecision(providerErrorCode, providerHttpStatus);
  return { ok: false, error: { code: "WHATSAPP_FLOW_PROVIDER_REJECTED", message: decision.message, retryable: false, providerErrorCode, providerHttpStatus } };
}
