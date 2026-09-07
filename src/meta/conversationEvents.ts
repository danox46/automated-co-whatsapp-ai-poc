import type {
  InternalConversationMessage,
  InternalMessageStatusUpdate,
  WhatsAppConversationWriter,
  WhatsAppMessageKind,
  WhatsAppMessageStatus
} from "../mcp/conversationHistory.js";

type RecordLike = Record<string, unknown>;

export type MetaConversationPersistence = {
  tenantId: string;
  conversationRefSecret: string;
  writer: WhatsAppConversationWriter;
};

export async function persistMetaConversationEvents(
  payload: unknown,
  persistence: MetaConversationPersistence
): Promise<{ messagesStored: number; statusesProcessed: number }> {
  if (!persistence.tenantId || !persistence.conversationRefSecret) {
    throw new Error("Conversation persistence is not configured");
  }

  let messagesStored = 0;
  let statusesProcessed = 0;
  for (const value of messageChangeValues(payload)) {
    const providerAccountRef = readString(readRecord(value.metadata)?.phone_number_id);
    if (!providerAccountRef) continue;
    const contacts = readArray(value.contacts).map(readRecord).filter(isRecord);

    for (const rawMessage of readArray(value.messages).map(readRecord).filter(isRecord)) {
      const providerParticipantRef = readString(rawMessage.from);
      const messageRef = readString(rawMessage.id);
      const occurredAt = metaTimestamp(rawMessage.timestamp);
      if (!providerParticipantRef || !messageRef || !occurredAt) continue;
      const conversationRef = await opaqueConversationRef(
        persistence.tenantId,
        providerAccountRef,
        providerParticipantRef,
        persistence.conversationRefSecret
      );
      const contact = contacts.find((candidate) => readString(candidate.wa_id) === providerParticipantRef);
      const profile = readRecord(contact?.profile);
      const normalized: InternalConversationMessage = {
        tenantId: persistence.tenantId,
        conversationRef,
        providerAccountRef,
        providerParticipantRef,
        ...(readString(profile?.name) ? { displayName: truncate(readString(profile?.name) as string, 200) } : {}),
        messageRef,
        direction: "inbound",
        kind: messageKind(rawMessage.type),
        ...messageContent(rawMessage),
        occurredAt,
        status: "received"
      };
      await persistence.writer.ingestMessage(normalized);
      messagesStored += 1;
    }

    for (const rawStatus of readArray(value.statuses).map(readRecord).filter(isRecord)) {
      const messageRef = readString(rawStatus.id);
      const status = messageStatus(rawStatus.status);
      const occurredAt = metaTimestamp(rawStatus.timestamp);
      if (!messageRef || !status || !occurredAt) continue;
      const update: InternalMessageStatusUpdate = {
        tenantId: persistence.tenantId,
        messageRef,
        status,
        occurredAt
      };
      await persistence.writer.updateMessageStatus(update);
      statusesProcessed += 1;
    }
  }

  return { messagesStored, statusesProcessed };
}

export async function opaqueConversationRef(
  tenantId: string,
  providerAccountRef: string,
  providerParticipantRef: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${tenantId}\u0000${providerAccountRef}\u0000${providerParticipantRef}`)
  ));
  const base64 = btoa(String.fromCharCode(...signature))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `conv_${base64.slice(0, 32)}`;
}

function* messageChangeValues(payload: unknown): Generator<RecordLike> {
  const envelope = readRecord(payload);
  for (const entry of readArray(envelope?.entry)) {
    const entryRecord = readRecord(entry);
    for (const change of readArray(entryRecord?.changes)) {
      const changeRecord = readRecord(change);
      if (changeRecord?.field !== "messages") continue;
      const value = readRecord(changeRecord.value);
      if (value) yield value;
    }
  }
}

function messageContent(message: RecordLike): { text?: string; templateName?: string } {
  const text = readString(readRecord(message.text)?.body);
  if (text) return { text: truncate(text, 4096) };
  const templateName = readString(readRecord(message.template)?.name);
  if (templateName) return { templateName: truncate(templateName, 512) };
  const buttonText = readString(readRecord(message.button)?.text);
  if (buttonText) return { text: truncate(buttonText, 4096) };
  const interactive = readRecord(message.interactive);
  const interactiveText = readString(readRecord(interactive?.button_reply)?.title)
    ?? readString(readRecord(interactive?.list_reply)?.title);
  return interactiveText ? { text: truncate(interactiveText, 4096) } : {};
}

function messageKind(value: unknown): WhatsAppMessageKind {
  const supported: WhatsAppMessageKind[] = [
    "text", "template", "interactive", "image", "audio", "video",
    "document", "location", "contact", "sticker", "reaction"
  ];
  return typeof value === "string" && supported.includes(value as WhatsAppMessageKind)
    ? value as WhatsAppMessageKind
    : "unknown";
}

function messageStatus(value: unknown): WhatsAppMessageStatus | null {
  const statuses: WhatsAppMessageStatus[] = ["sent", "delivered", "read", "failed"];
  return typeof value === "string" && statuses.includes(value as WhatsAppMessageStatus)
    ? value as WhatsAppMessageStatus
    : null;
}

function metaTimestamp(value: unknown): string | null {
  const seconds = typeof value === "string" && /^\d{1,13}$/.test(value)
    ? Number(value)
    : typeof value === "number"
      ? value
      : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function readRecord(value: unknown): RecordLike | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}
