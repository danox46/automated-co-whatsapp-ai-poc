import type {
  InternalStoredAttachment,
  WhatsAppConversationWriter
} from "../mcp/conversationHistory.js";
import type { WhatsAppAttachmentContentStore } from "../mcp/attachmentContent.js";
import { decryptPilotSecret } from "./pilotCrypto.js";
import { MetaGraphError, type createMetaGraphClient } from "./graphClient.js";
import type { createPilotInstallationRegistry } from "./pilotInstallationStore.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

export function createMetaAttachmentCapture(input: {
  registry: ReturnType<typeof createPilotInstallationRegistry>;
  graph: ReturnType<typeof createMetaGraphClient>;
  encryptionKey: string;
  contentStore: WhatsAppAttachmentContentStore;
  writer: WhatsAppConversationWriter;
}) {
  return async (attachment: InternalStoredAttachment & { tenantId: string }): Promise<void> => {
    if (attachment.state === "unsupported" || attachment.kind !== "image") return;
    const fail = async () => input.writer.updateAttachmentState({
      tenantId: attachment.tenantId,
      conversationRef: attachment.conversationRef,
      attachmentRef: attachment.attachmentRef,
      state: "failed"
    });
    try {
      const installation = await input.registry.getInstallation(attachment.tenantId);
      if (installation?.status !== "connected" || installation.phoneNumberId !== attachment.providerAccountRef) {
        await fail();
        return;
      }
      const accessToken = await decryptPilotSecret(
        installation.encryptedAccessToken,
        input.encryptionKey
      );
      const metadata = await input.graph.retrieveMediaMetadata(
        accessToken,
        attachment.providerMediaRef,
        installation.phoneNumberId
      );
      if (!ALLOWED_IMAGE_MIME_TYPES.has(metadata.mimeType) || metadata.mimeType !== attachment.mimeType) {
        await fail();
        return;
      }
      if (metadata.fileSize && metadata.fileSize > MAX_IMAGE_BYTES) {
        await fail();
        return;
      }
      const downloaded = await input.graph.downloadMedia(accessToken, metadata.url, MAX_IMAGE_BYTES);
      if (downloaded.contentType && downloaded.contentType !== metadata.mimeType) {
        await fail();
        return;
      }
      if (!matchesImageMagic(downloaded.bytes, metadata.mimeType)) {
        await fail();
        return;
      }
      const expectedHash = metadata.sha256 ?? attachment.sha256;
      if (expectedHash && await sha256Base64(downloaded.bytes) !== expectedHash) {
        await fail();
        return;
      }
      await input.contentStore.putAttachmentContent(
        attachment.tenantId,
        attachment.conversationRef,
        attachment.attachmentRef,
        downloaded.bytes
      );
      await input.writer.updateAttachmentState({
        tenantId: attachment.tenantId,
        conversationRef: attachment.conversationRef,
        attachmentRef: attachment.attachmentRef,
        state: "ready",
        sizeBytes: downloaded.bytes.byteLength
      });
    } catch (error) {
      if (error instanceof MetaGraphError && !error.retryable) {
        await fail();
        return;
      }
      throw error;
    }
  };
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return btoa(String.fromCharCode(...digest));
}

function matchesImageMagic(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}
