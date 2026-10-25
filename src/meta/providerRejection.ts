import type { DurableConversationObjectStub } from "../mcp/durableConversationStore.js";
import type { WhatsAppProtectionDecision } from "../mcp/outboundPolicy.js";
import { MetaGraphError } from "./graphClient.js";

export function providerRejectionDecision(providerErrorCode: string, providerHttpStatus: number): WhatsAppProtectionDecision {
  return {
    allowed: false, code: "WHATSAPP_PROVIDER_REJECTED", retryable: false, protectedBy: "meta-provider",
    providerErrorCode, providerHttpStatus, requiredAction: "human_review_required",
    message: `Meta explicitly rejected this send (HTTP ${providerHttpStatus}; ${providerErrorCode}). The original rejection is retained; this intent will not send again. Resolve the provider error before requesting another action.`
  };
}

/** Called only around provider I/O, never to reinterpret an old reservation. */
export async function recordDefiniteProviderRejection(
  store: DurableConversationObjectStub,
  intent: { idempotencyKey: string; requestFingerprint: string },
  error: unknown,
  rejectedAt: string
): Promise<WhatsAppProtectionDecision | null> {
  if (!(error instanceof MetaGraphError) || !error.definiteRejection ||
      !/^META_MESSAGE_DISPATCH_FAILED_\d{1,16}$/u.test(error.code)) return null;
  const receipt = await store.recordProviderRejection({ ...intent, providerErrorCode: error.code, providerHttpStatus: error.status, rejectedAt });
  if (!receipt.recorded) throw new Error("META_REJECTION_RECEIPT_NOT_STORED");
  return providerRejectionDecision(error.code, error.status);
}
