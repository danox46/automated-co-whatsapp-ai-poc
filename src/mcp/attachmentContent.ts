import type {
  StoredMessageAttachment
} from "./conversationHistory.js";
import type { WhatsAppMcpPrincipal } from "./auth.js";

export type WhatsAppAttachmentContent = {
  attachment: StoredMessageAttachment;
  data: Uint8Array;
};

export interface WhatsAppAttachmentContentReader {
  getAttachmentContent(
    principal: WhatsAppMcpPrincipal,
    conversationRef: string,
    attachmentRef: string
  ): Promise<WhatsAppAttachmentContent | null>;
}

export interface WhatsAppAttachmentContentStore {
  putAttachmentContent(
    tenantId: string,
    conversationRef: string,
    attachmentRef: string,
    data: Uint8Array
  ): Promise<void>;
}
