import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConversationContext, ConversationTurn } from "../sessions/conversationSessionStore.js";
import type { InboundMessage, InboundMediaReference } from "../messages/types.js";

export type ConversationMode = "bot" | "human";
export type MessageAuthor = "customer" | "bot" | "operator" | "system";
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed" | "undelivered" | "received" | null;

export type ConversationSummary = {
  id: string;
  contactId: string;
  phone: string;
  waId: string | null;
  publicProfileName: string | null;
  localAlias: string | null;
  displayName: string;
  mode: ConversationMode;
  unreadCount: number;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  preview: string;
  serviceWindowClosesAt: string | null;
};

export type StoredMedia = {
  id: string;
  messageId: string;
  providerUrl: string;
  contentType: string;
  byteSize: number | null;
  originalFilename: string | null;
  localPath: string | null;
  status: "pending" | "ready" | "rejected" | "failed";
  errorMessage: string | null;
};

export type StoredMessage = {
  id: string;
  conversationId: string;
  providerSid: string | null;
  direction: "inbound" | "outbound" | "system";
  author: MessageAuthor;
  body: string;
  providerStatus: MessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  media: StoredMedia[];
};

type Row = Record<string, unknown>;

export class OperatorRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date()
  ) {}

  ingestInbound(message: InboundMessage) {
    const phone = message.from?.trim();
    if (!phone) throw new Error("Inbound WhatsApp message is missing From.");
    if (!message.providerMessageId) throw new Error("Inbound WhatsApp message is missing MessageSid.");

    const receivedAt = message.receivedAt || this.now().toISOString();
    const profileName = cleanOptional(message.profileName);
    const waId = cleanOptional(message.waId);
    const media = message.media ?? [];

    return this.transaction(() => {
      let contact = this.database.prepare("SELECT * FROM contacts WHERE phone = ?").get(phone) as Row | undefined;
      if (!contact) {
        const contactId = randomUUID();
        this.database.prepare(`
          INSERT INTO contacts(id, phone, wa_id, public_profile_name, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(contactId, phone, waId ?? null, profileName ?? null, receivedAt, receivedAt);
        contact = this.database.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as Row;
      } else if (waId || profileName) {
        this.database.prepare(`
          UPDATE contacts
          SET wa_id = COALESCE(?, wa_id),
              public_profile_name = COALESCE(?, public_profile_name),
              updated_at = ?
          WHERE id = ?
        `).run(waId ?? null, profileName ?? null, receivedAt, String(contact.id));
        contact = this.database.prepare("SELECT * FROM contacts WHERE id = ?").get(String(contact.id)) as Row;
      }

      let createdConversation = false;
      let conversation = this.database
        .prepare("SELECT * FROM conversations WHERE contact_id = ?")
        .get(String(contact.id)) as Row | undefined;
      if (!conversation) {
        createdConversation = true;
        const conversationId = randomUUID();
        this.database.prepare(`
          INSERT INTO conversations(
            id, contact_id, mode, unread_count, last_inbound_at, last_message_at, created_at, updated_at
          ) VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)
        `).run(conversationId, String(contact.id), mediaOnly(message) ? "human" : "bot", receivedAt, receivedAt);
        conversation = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as Row;
      }

      const duplicate = this.database
        .prepare("SELECT id FROM messages WHERE provider_sid = ?")
        .get(message.providerMessageId ?? null) as Row | undefined;
      if (duplicate) {
        return {
          created: false,
          conversationId: String(conversation.id),
          contactId: String(contact.id),
          messageId: String(duplicate.id),
          mode: String(conversation.mode) as ConversationMode,
          createdConversation: false,
          mediaIds: [] as string[]
        };
      }

      const messageId = randomUUID();
      this.database.prepare(`
        INSERT INTO messages(
          id, conversation_id, provider_sid, direction, author, body, provider_status, created_at
        ) VALUES (?, ?, ?, 'inbound', 'customer', ?, 'received', ?)
      `).run(messageId, String(conversation.id), message.providerMessageId ?? null, message.body, receivedAt);

      const nextMode: ConversationMode = mediaOnly(message)
        ? "human"
        : (String(conversation.mode) as ConversationMode);
      this.database.prepare(`
        UPDATE conversations
        SET mode = ?, unread_count = unread_count + 1,
            last_inbound_at = ?, last_message_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nextMode, receivedAt, receivedAt, receivedAt, String(conversation.id));

      const mediaIds = media.map((item) => this.insertPendingMedia(messageId, item, receivedAt));
      if (mediaOnly(message)) {
        this.insertAudit("mode_changed", String(conversation.id), String(contact.id), {
          from: conversation.mode,
          to: "human",
          reason: "media_only_inbound"
        }, receivedAt);
      }

      return {
        created: true,
        conversationId: String(conversation.id),
        contactId: String(contact.id),
        messageId,
        mode: nextMode,
        createdConversation,
        mediaIds
      };
    });
  }

  listConversations(search = "", filter: "all" | "unread" | "human" = "all") {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (search.trim()) {
      clauses.push("(LOWER(COALESCE(ct.local_alias, '')) LIKE ? OR LOWER(COALESCE(ct.public_profile_name, '')) LIKE ? OR ct.phone LIKE ?)");
      const query = `%${search.trim().toLowerCase()}%`;
      params.push(query, query, `%${search.trim()}%`);
    }
    if (filter === "unread") clauses.push("c.unread_count > 0");
    if (filter === "human") clauses.push("c.mode = 'human'");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.database.prepare(`
      SELECT c.*, ct.phone, ct.wa_id, ct.public_profile_name, ct.local_alias,
        COALESCE(NULLIF(ct.local_alias, ''), NULLIF(ct.public_profile_name, ''), ct.phone) AS display_name,
        COALESCE((SELECT NULLIF(m.body, '') FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1),
                 (SELECT '[Archivo recibido]' FROM received_media rm JOIN messages mm ON mm.id = rm.message_id WHERE mm.conversation_id = c.id ORDER BY rm.created_at DESC LIMIT 1), '') AS preview
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      ${where}
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
    `).all(...params) as Row[];

    return rows.map((row) => this.mapConversation(row));
  }

  getConversation(conversationId: string): ConversationSummary | undefined {
    const row = this.database.prepare(`
      SELECT c.*, ct.phone, ct.wa_id, ct.public_profile_name, ct.local_alias,
        COALESCE(NULLIF(ct.local_alias, ''), NULLIF(ct.public_profile_name, ''), ct.phone) AS display_name,
        COALESCE((SELECT NULLIF(m.body, '') FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1), '') AS preview
      FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?
    `).get(conversationId) as Row | undefined;
    return row ? this.mapConversation(row) : undefined;
  }

  getMessages(conversationId: string): StoredMessage[] {
    const messages = this.database
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid")
      .all(conversationId) as Row[];
    const mediaStatement = this.database.prepare("SELECT * FROM received_media WHERE message_id = ? ORDER BY created_at, rowid");
    return messages.map((row) => ({
      id: String(row.id),
      conversationId: String(row.conversation_id),
      providerSid: nullableString(row.provider_sid),
      direction: String(row.direction) as StoredMessage["direction"],
      author: String(row.author) as MessageAuthor,
      body: String(row.body ?? ""),
      providerStatus: nullableString(row.provider_status) as MessageStatus,
      errorCode: nullableString(row.error_code),
      errorMessage: nullableString(row.error_message),
      createdAt: String(row.created_at),
      media: (mediaStatement.all(String(row.id)) as Row[]).map(mapMedia)
    }));
  }

  getConversationContext(conversationId: string): ConversationContext | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    const turns: ConversationTurn[] = this.getMessages(conversationId)
      .filter((message) => message.direction !== "system")
      .slice(-20)
      .map((message) => ({
        direction: message.direction === "inbound" ? "inbound" : "outbound",
        body: message.body,
        at: message.createdAt
      }));
    return {
      sessionId: conversation.id,
      participantKey: conversation.phone,
      startedAt: turns[0]?.at ?? conversation.lastInboundAt ?? this.now().toISOString(),
      lastSeenAt: conversation.lastInboundAt ?? this.now().toISOString(),
      windowHours: 24,
      automationDisclosureSent: false,
      turns
    };
  }

  setAlias(contactId: string, alias: string | null) {
    const now = this.now().toISOString();
    const cleanAlias = cleanOptional(alias ?? undefined) ?? null;
    const contact = this.database.prepare("SELECT id FROM contacts WHERE id = ?").get(contactId) as Row | undefined;
    if (!contact) return false;
    this.transaction(() => {
      this.database.prepare("UPDATE contacts SET local_alias = ?, updated_at = ? WHERE id = ?").run(cleanAlias, now, contactId);
      this.insertAudit("alias_changed", null, contactId, { alias: cleanAlias }, now);
    });
    return true;
  }

  setMode(conversationId: string, mode: ConversationMode, reason = "operator_action") {
    const now = this.now().toISOString();
    const existing = this.database.prepare("SELECT mode, contact_id FROM conversations WHERE id = ?").get(conversationId) as Row | undefined;
    if (!existing) return false;
    this.transaction(() => {
      this.database.prepare("UPDATE conversations SET mode = ?, updated_at = ? WHERE id = ?").run(mode, now, conversationId);
      this.insertAudit("mode_changed", conversationId, String(existing.contact_id), { from: existing.mode, to: mode, reason }, now);
    });
    return true;
  }

  markRead(conversationId: string, read: boolean) {
    const result = this.database
      .prepare("UPDATE conversations SET unread_count = ?, updated_at = ? WHERE id = ?")
      .run(read ? 0 : 1, this.now().toISOString(), conversationId);
    if (result.changes) this.insertAudit("unread_changed", conversationId, null, { read });
    return result.changes > 0;
  }

  createOutboundMessage(input: {
    conversationId: string;
    body: string;
    author: "bot" | "operator";
    switchToHuman?: boolean;
    createdAt?: string;
  }) {
    const now = input.createdAt ?? this.now().toISOString();
    return this.transaction(() => {
      const conversation = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(input.conversationId) as Row | undefined;
      if (!conversation) throw new Error("Conversation not found.");
      if (input.author === "operator") this.assertServiceWindow(String(conversation.last_inbound_at));
      if (input.switchToHuman || input.author === "operator") {
        this.database.prepare("UPDATE conversations SET mode = 'human', updated_at = ? WHERE id = ?").run(now, input.conversationId);
        this.insertAudit("mode_changed", input.conversationId, String(conversation.contact_id), {
          from: conversation.mode,
          to: "human",
          reason: input.author === "operator" ? "operator_reply" : "automation_escalation"
        }, now);
      }
      const messageId = randomUUID();
      this.database.prepare(`
        INSERT INTO messages(id, conversation_id, direction, author, body, provider_status, created_at)
        VALUES (?, ?, 'outbound', ?, ?, 'queued', ?)
      `).run(messageId, input.conversationId, input.author, input.body, now);
      this.database.prepare("UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?").run(now, now, input.conversationId);
      return { messageId, createdAt: now };
    });
  }

  addSystemMessage(conversationId: string, body: string) {
    const now = this.now().toISOString();
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO messages(id, conversation_id, direction, author, body, created_at)
      VALUES (?, ?, 'system', 'system', ?, ?)
    `).run(id, conversationId, body, now);
    this.database.prepare("UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?").run(now, now, conversationId);
    return id;
  }

  attachProviderResult(messageId: string, providerSid: string, status: string) {
    this.database.prepare("UPDATE messages SET provider_sid = ?, provider_status = ? WHERE id = ?").run(providerSid, status, messageId);
  }

  markOutboundFailed(messageId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.database.prepare("UPDATE messages SET provider_status = 'failed', error_message = ? WHERE id = ?").run(message, messageId);
  }

  updateMessageStatus(providerSid: string, status: string, errorCode?: string, errorMessage?: string) {
    const result = this.database.prepare(`
      UPDATE messages SET provider_status = ?, error_code = ?, error_message = ? WHERE provider_sid = ?
    `).run(status, cleanOptional(errorCode) ?? null, cleanOptional(errorMessage) ?? null, providerSid);
    return result.changes > 0;
  }

  getMedia(mediaId: string): StoredMedia | undefined {
    const row = this.database.prepare("SELECT * FROM received_media WHERE id = ?").get(mediaId) as Row | undefined;
    return row ? mapMedia(row) : undefined;
  }

  updateMedia(mediaId: string, input: {
    status: StoredMedia["status"];
    localPath?: string;
    byteSize?: number;
    contentType?: string;
    originalFilename?: string;
    errorMessage?: string;
  }) {
    this.database.prepare(`
      UPDATE received_media
      SET status = ?, local_path = ?, byte_size = ?, content_type = COALESCE(?, content_type), original_filename = ?, error_message = ?
      WHERE id = ?
    `).run(
      input.status,
      input.localPath ?? null,
      input.byteSize ?? null,
      input.contentType ?? null,
      input.originalFilename ?? null,
      input.errorMessage ?? null,
      mediaId
    );
  }

  listPendingMedia(messageId: string) {
    return (this.database.prepare("SELECT * FROM received_media WHERE message_id = ? AND status = 'pending'").all(messageId) as Row[]).map(mapMedia);
  }

  deleteConversation(conversationId: string) {
    return this.transaction(() => {
      const media = this.database.prepare(`
        SELECT rm.local_path FROM received_media rm
        JOIN messages m ON m.id = rm.message_id
        WHERE m.conversation_id = ? AND rm.local_path IS NOT NULL
      `).all(conversationId) as Row[];
      const conversation = this.database.prepare("SELECT contact_id FROM conversations WHERE id = ?").get(conversationId) as Row | undefined;
      if (!conversation) return undefined;
      this.insertAudit("conversation_deleted", conversationId, String(conversation.contact_id), {}, this.now().toISOString());
      this.database.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      this.database.prepare(`
        DELETE FROM contacts WHERE id = ? AND NOT EXISTS (SELECT 1 FROM conversations WHERE contact_id = ?)
      `).run(String(conversation.contact_id), String(conversation.contact_id));
      return media.map((row) => String(row.local_path));
    });
  }

  getMeta(key: string) {
    const row = this.database.prepare("SELECT value FROM runtime_meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  setMeta(key: string, value: string) {
    const now = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO runtime_meta(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now);
  }

  recordAudit(eventType: string, payload: unknown, conversationId?: string, contactId?: string) {
    this.insertAudit(eventType, conversationId ?? null, contactId ?? null, payload, this.now().toISOString());
  }

  private insertPendingMedia(messageId: string, media: InboundMediaReference, createdAt: string) {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO received_media(id, message_id, provider_url, content_type, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(id, messageId, media.url, media.contentType, createdAt);
    return id;
  }

  private mapConversation(row: Row): ConversationSummary {
    const lastInboundAt = nullableString(row.last_inbound_at);
    return {
      id: String(row.id),
      contactId: String(row.contact_id),
      phone: String(row.phone),
      waId: nullableString(row.wa_id),
      publicProfileName: nullableString(row.public_profile_name),
      localAlias: nullableString(row.local_alias),
      displayName: String(row.display_name),
      mode: String(row.mode) as ConversationMode,
      unreadCount: Number(row.unread_count),
      lastInboundAt,
      lastMessageAt: nullableString(row.last_message_at),
      preview: String(row.preview ?? ""),
      serviceWindowClosesAt: lastInboundAt
        ? new Date(Date.parse(lastInboundAt) + 24 * 60 * 60 * 1000).toISOString()
        : null
    };
  }

  private assertServiceWindow(lastInboundAt: string) {
    if (!lastInboundAt || this.now().getTime() - Date.parse(lastInboundAt) >= 24 * 60 * 60 * 1000) {
      throw new ServiceWindowClosedError();
    }
  }

  private insertAudit(
    eventType: string,
    conversationId: string | null,
    contactId: string | null,
    payload: unknown,
    createdAt = this.now().toISOString()
  ) {
    this.database.prepare(`
      INSERT INTO audit_events(id, conversation_id, contact_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), conversationId, contactId, eventType, JSON.stringify(payload ?? {}), createdAt);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }
}

export class ServiceWindowClosedError extends Error {
  constructor() {
    super("The 24-hour WhatsApp service window is closed.");
    this.name = "ServiceWindowClosedError";
  }
}

function mediaOnly(message: InboundMessage) {
  return message.body.trim().length === 0 && (message.media?.length ?? 0) > 0;
}

function cleanOptional(value?: string) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function mapMedia(row: Row): StoredMedia {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    providerUrl: String(row.provider_url),
    contentType: String(row.content_type),
    byteSize: row.byte_size === null || row.byte_size === undefined ? null : Number(row.byte_size),
    originalFilename: nullableString(row.original_filename),
    localPath: nullableString(row.local_path),
    status: String(row.status) as StoredMedia["status"],
    errorMessage: nullableString(row.error_message)
  };
}
