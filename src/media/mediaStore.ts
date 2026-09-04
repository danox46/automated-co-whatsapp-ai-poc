import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import type { StoredMedia } from "../persistence/operatorRepository.js";

export const MAX_WHATSAPP_MEDIA_BYTES = 16 * 1024 * 1024;

const allowedTypes = new Set([
  "application/pdf",
  "audio/aac",
  "audio/amr",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

const extensions: Record<string, string> = {
  "application/pdf": ".pdf",
  "audio/aac": ".aac",
  "audio/amr": ".amr",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};

export type MediaDownloadConfig = {
  accountSid?: string;
  authToken?: string;
  mediaRoot: string;
};

export async function downloadTwilioMedia(media: StoredMedia, config: MediaDownloadConfig) {
  if (!config.accountSid || !config.authToken) {
    throw new Error("Twilio credentials are required to download received media.");
  }
  const sourceUrl = new URL(media.providerUrl);
  if (sourceUrl.protocol !== "https:" || !isTwilioHost(sourceUrl.hostname)) {
    throw new Error("Rejected media URL outside Twilio HTTPS hosts.");
  }

  const declaredType = normalizeContentType(media.contentType);
  if (!allowedTypes.has(declaredType)) {
    throw new Error(`Unsupported received media type: ${declaredType}`);
  }

  const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  const response = await fetch(sourceUrl, {
    headers: { Authorization: `Basic ${credentials}` },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Twilio media download failed with HTTP ${response.status}.`);

  const responseType = normalizeContentType(response.headers.get("content-type") ?? declaredType);
  if (!allowedTypes.has(responseType)) {
    throw new Error(`Unsupported downloaded media type: ${responseType}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_WHATSAPP_MEDIA_BYTES) {
    throw new Error("Received media exceeds the 16 MB WhatsApp limit.");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_WHATSAPP_MEDIA_BYTES) {
    throw new Error("Received media exceeds the 16 MB WhatsApp limit.");
  }

  const root = resolve(config.mediaRoot);
  await mkdir(root, { recursive: true });
  const extension = extensions[responseType] ?? extensions[declaredType] ?? "";
  const localPath = resolve(root, `${media.id}${extension}`);
  assertWithinRoot(root, localPath);
  await writeFile(localPath, bytes, { flag: "wx" });

  return {
    localPath,
    byteSize: bytes.byteLength,
    contentType: responseType,
    originalFilename: contentDispositionFilename(response.headers.get("content-disposition")) ?? `archivo${extension}`
  };
}

export async function deleteStoredMedia(paths: string[], mediaRoot: string) {
  const root = resolve(mediaRoot);
  for (const path of paths) {
    const target = resolve(path);
    assertWithinRoot(root, target);
    await rm(target, { force: true });
  }
}

export function assertWithinRoot(root: string, target: string) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("Unsafe media path rejected.");
  }
}

export function sanitizeFilename(value: string) {
  const cleaned = basename(value)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "archivo").slice(0, 120);
}

function contentDispositionFilename(header: string | null) {
  if (!header) return undefined;
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return sanitizeFilename(decodeURIComponent(encoded));
    } catch {
      return sanitizeFilename(encoded);
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i)?.[1];
  return plain ? sanitizeFilename(plain) : undefined;
}

function normalizeContentType(value: string) {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function isTwilioHost(hostname: string) {
  const lower = hostname.toLowerCase();
  return lower === "twilio.com" || lower.endsWith(".twilio.com");
}
