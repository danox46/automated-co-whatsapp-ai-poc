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

export type AttachmentCaptureResult = {
  state: "ready" | "failed" | "unsupported";
  reason?: string;
};

export function createMetaAttachmentCapture(input: {
  registry: ReturnType<typeof createPilotInstallationRegistry>;
  graph: ReturnType<typeof createMetaGraphClient>;
  encryptionKey: string;
  contentStore: WhatsAppAttachmentContentStore;
  writer: WhatsAppConversationWriter;
}) {
  return async (attachment: InternalStoredAttachment & { tenantId: string }): Promise<AttachmentCaptureResult> => {
    if (attachment.state === "unsupported" || attachment.kind !== "image") return { state: "unsupported" };
    const fail = async (reason: string): Promise<AttachmentCaptureResult> => captureStep(
      "ATTACHMENT_FAILURE_STATE_UPDATE_FAILED",
      async () => {
        await input.writer.updateAttachmentState({
          tenantId: attachment.tenantId,
          conversationRef: attachment.conversationRef,
          attachmentRef: attachment.attachmentRef,
          state: "failed"
        });
        return { state: "failed", reason };
      }
    );
    try {
      const installation = await captureStep(
        "ATTACHMENT_INSTALLATION_READ_FAILED",
        () => input.registry.getInstallation(attachment.tenantId)
      );
      if (installation?.status !== "connected" || installation.phoneNumberId !== attachment.providerAccountRef) {
        return fail("INSTALLATION_MISMATCH");
      }
      const accessToken = await captureStep(
        "ATTACHMENT_CREDENTIAL_DECRYPT_FAILED",
        () => decryptPilotSecret(installation.encryptedAccessToken, input.encryptionKey)
      );
      const metadata = await captureStep(
        "ATTACHMENT_METADATA_LOOKUP_FAILED",
        () => input.graph.retrieveMediaMetadata(
          accessToken,
          attachment.providerMediaRef,
          installation.phoneNumberId
        )
      );
      if (!ALLOWED_IMAGE_MIME_TYPES.has(metadata.mimeType) || metadata.mimeType !== attachment.mimeType) {
        return fail("MIME_TYPE_MISMATCH");
      }
      if (metadata.fileSize && metadata.fileSize > MAX_IMAGE_BYTES) {
        return fail("IMAGE_TOO_LARGE");
      }
      const downloaded = await captureStep(
        "ATTACHMENT_MEDIA_DOWNLOAD_FAILED",
        () => input.graph.downloadMedia(accessToken, metadata.url, MAX_IMAGE_BYTES)
      );
      if (downloaded.contentType && downloaded.contentType !== metadata.mimeType &&
          downloaded.contentType !== "application/octet-stream") {
        return fail("CONTENT_TYPE_MISMATCH");
      }
      if (!matchesImageMagic(downloaded.bytes, metadata.mimeType)) {
        return fail("IMAGE_SIGNATURE_INVALID");
      }
      const actualHash = await captureStep(
        "ATTACHMENT_HASH_FAILED",
        () => sha256Base64(downloaded.bytes)
      );
      const providerHashes = [metadata.sha256, attachment.sha256].filter(
        (value): value is string => Boolean(value)
      );
      if (providerHashes.length > 0 && !providerHashes.includes(actualHash)) {
        return fail("HASH_MISMATCH");
      }
      const metadataHashMismatch = Boolean(
        metadata.sha256 && metadata.sha256 !== actualHash && attachment.sha256 === actualHash
      );
      await captureStep(
        "ATTACHMENT_CONTENT_STORE_FAILED",
        () => input.contentStore.putAttachmentContent(
          attachment.tenantId,
          attachment.conversationRef,
          attachment.attachmentRef,
          downloaded.bytes
        )
      );
      await captureStep(
        "ATTACHMENT_STATE_UPDATE_FAILED",
        () => input.writer.updateAttachmentState({
          tenantId: attachment.tenantId,
          conversationRef: attachment.conversationRef,
          attachmentRef: attachment.attachmentRef,
          state: "ready",
          sizeBytes: downloaded.bytes.byteLength,
          sha256: actualHash
        })
      );
      return {
        state: "ready",
        ...(metadataHashMismatch ? { reason: "MEDIA_METADATA_HASH_MISMATCH_WEBHOOK_HASH_VERIFIED" } : {})
      };
    } catch (error) {
      if (error instanceof MetaGraphError && !error.retryable) {
        return fail(error.code);
      }
      throw error;
    }
  };
}

async function captureStep<T>(code: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MetaGraphError || (error instanceof Error && /^[A-Z0-9_]{3,160}$/u.test(error.message))) {
      throw error;
    }
    throw new Error(`${code}_${captureFailureClass(error)}`, { cause: error });
  }
}

function captureFailureClass(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN";
  const message = error.message.toLowerCase();
  if (message.includes("redirect")) return "REDIRECT";
  if (message.includes("network")) return "NETWORK";
  if (message.includes("fetch")) return "FETCH";
  if (message.includes("timed out") || message.includes("timeout")) return "TIMEOUT";
  if (message.includes("arraybuffer") || message.includes("typed array")) return "BINARY_VALUE";
  if (message.includes("sql") || message.includes("database")) return "DATABASE";
  if (error.name === "TypeError") return "TYPE_ERROR";
  if (error.name === "RangeError") return "RANGE_ERROR";
  return "INTERNAL";
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
