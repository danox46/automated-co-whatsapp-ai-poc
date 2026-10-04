import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import {
  boundedLimit,
  decodeCursor,
  DEFAULT_CONVERSATION_PAGE_SIZE,
  DEFAULT_MESSAGE_PAGE_SIZE,
  encodeCursor,
  MAX_CONVERSATION_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  summarizeConversation,
  type ConversationHistoryQuery,
  type ConversationHistoryResult,
  type ConversationListQuery,
  type ConversationListResult,
  type InternalConversationMessage,
  type InternalConversationEnforcementState,
  type InternalConversationPolicyPatch,
  type InternalAttachmentStateUpdate,
  type InternalStoredAttachment,
  type InternalMessageStatusUpdate,
  type StoredConversation,
  type StoredConversationMessage,
  type WhatsAppConversationReader,
  type WhatsAppConversationEnforcementReader,
  type WhatsAppConversationWriter,
  type WhatsAppAttachmentReader,
  type WhatsAppMessageStatus
} from "./conversationHistory.js";
import {
  validateConversationRetentionPolicy,
  type ConversationRetentionPolicy
} from "./retentionPolicy.js";
import type {
  WhatsAppAttachmentContentReader,
  WhatsAppAttachmentContentStore
} from "./attachmentContent.js";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;

type ConversationRow = {
  conversation_ref: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  last_verified_user_inbound_at: string | null;
  last_outbound_at: string | null;
  message_count: number;
  unread_inbound_count: number;
  recipient_opted_out: number;
  automation_paused: number;
  policy_revision: string;
};

type MessageRow = {
  message_ref: string;
  conversation_ref: string;
  direction: "inbound" | "outbound";
  kind: StoredConversationMessage["kind"];
  body_text: string | null;
  template_name: string | null;
  attachment_ref: string | null;
  attachment_kind: InternalStoredAttachment["kind"] | null;
  attachment_mime_type: string | null;
  attachment_sha256: string | null;
  attachment_caption: string | null;
  attachment_filename: string | null;
  attachment_size_bytes: number | null;
  attachment_state: InternalStoredAttachment["state"] | null;
  provider_media_ref: string | null;
  media_storage_key: string | null;
  occurred_at: string;
  status: WhatsAppMessageStatus;
};

type InternalConversationRow = ConversationRow & {
  provider_account_ref: string;
  provider_participant_ref: string;
};

type CountRow = { count: number };
type MetadataRow = { value: string };
type VersionRow = { version: number };

export type ConversationRetentionResult = {
  ranAt: string;
  messageCutoff: string;
  inactiveConversationCutoff: string;
  pendingStatusCutoff: string;
  messagesDeleted: number;
  conversationsDeleted: number;
  pendingStatusesDeleted: number;
  nextRunAt: string;
};

export type ConversationDeletionResult = {
  conversationsDeleted: number;
  messagesDeleted: number;
  pendingStatusesDeleted: number;
};

export type DurableConversationObjectStub = {
  initializeTenant(tenantId: string): Promise<void>;
  registerConversation(input: {
    conversationRef: string;
    providerAccountRef: string;
    providerParticipantRef: string;
    displayName?: string;
    registeredAt: string;
  }): Promise<void>;
  ingestMessage(message: Omit<InternalConversationMessage, "tenantId">): Promise<void>;
  updateMessageStatus(update: Omit<InternalMessageStatusUpdate, "tenantId">): Promise<void>;
  updateAttachmentState(update: Omit<InternalAttachmentStateUpdate, "tenantId">): Promise<void>;
  getAttachment(
    conversationRef: string,
    attachmentRef: string
  ): Promise<Omit<InternalStoredAttachment, "providerAccountRef"> & { providerAccountRef: string } | null>;
  putAttachmentContent(conversationRef: string, attachmentRef: string, data: Uint8Array): Promise<void>;
  getAttachmentContent(conversationRef: string, attachmentRef: string): Promise<Uint8Array | null>;
  updatePolicyState(patch: Omit<InternalConversationPolicyPatch, "tenantId">): Promise<void>;
  markConversationRead(conversationRef: string, readAt: string): Promise<void>;
  getConversationEnforcementState(
    conversationRef: string
  ): Promise<InternalConversationEnforcementState | null>;
  reserveOutboundDispatch(input: OutboundDispatchReservation): Promise<OutboundDispatchReservationResult>;
  getOutboundDispatchResult(input: { idempotencyKey: string; requestFingerprint: string }): Promise<Exclude<OutboundDispatchReservationResult, { status: "ready" }> | null>;
  cancelUnsentOutboundDispatch(input: { idempotencyKey: string; requestFingerprint: string }): Promise<void>;
  completeOutboundDispatch(input: OutboundDispatchCompletion): Promise<void>;
  getOutboundPolicy(conversationRef: string): Promise<{
    approvedTemplates: Array<{ name: string; category: string; purpose: string; languageCode?: string; enabled: boolean }>;
    consentedTemplateCategories: string[];
    consentedTemplatePurposes: string[];
  }>;
  upsertApprovedTemplate(template: {
    name: string;
    category: string;
    purpose: string;
    languageCode: string;
    enabled: boolean;
  }): Promise<void>;
  setConversationTemplateConsent(input: {
    conversationRef: string;
    categories: string[];
    purposes: string[];
    policyRevision: string;
    updatedAt: string;
  }): Promise<void>;
  configureRetention(policy: ConversationRetentionPolicy, now: string): Promise<void>;
  runRetention(now: string): Promise<ConversationRetentionResult>;
  deleteConversationData(conversationRef: string): Promise<ConversationDeletionResult>;
  deleteAllConversationData(): Promise<ConversationDeletionResult>;
  pruneMessages(occurredBefore: string): Promise<number>;
  listConversations(query: ConversationListQuery): Promise<ConversationListResult>;
  getConversationHistory(query: ConversationHistoryQuery): Promise<ConversationHistoryResult | null>;
};

export type OutboundDispatchReservation = {
  conversationRef: string;
  kind: "free_form_reply" | "approved_template";
  idempotencyKey: string;
  requestFingerprint: string;
  expectedPolicyRevision: string;
  now: string;
  notAfter?: string;
  expectedProviderAccountRef?: string;
  template?: { name: string; category: string; purpose: string; languageCode: string };
};

export type OutboundDispatchReservationResult =
  | { status: "ready"; providerAccountRef: string; providerParticipantRef: string }
  | { status: "duplicate"; messageRef: string; providerStatus: "accepted" | "queued" | "sent" }
  | { status: "blocked"; reason: "state_changed" | "recipient_opted_out" | "automation_paused" | "window_closed" | "in_progress" | "template_unavailable" | "template_consent_required" };

export type OutboundDispatchCompletion = {
  idempotencyKey: string;
  requestFingerprint: string;
  conversationRef: string;
  providerAccountRef: string;
  providerParticipantRef: string;
  messageRef: string;
  providerStatus: "accepted" | "queued" | "sent";
  kind: "text" | "template";
  text?: string;
  templateName?: string;
  occurredAt: string;
};

export type DurableConversationNamespace = {
  getByName(name: string): DurableConversationObjectStub;
};

export class WhatsAppConversationDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  async initializeTenant(tenantId: string): Promise<void> {
    if (!tenantId || tenantId.length > 200) throw new Error("Invalid tenant identity");
    const existing = this.ctx.storage.sql
      .exec<MetadataRow>("SELECT value FROM metadata WHERE key = 'tenant_id'")
      .toArray()[0];
    if (existing && existing.value !== tenantId) throw new Error("Tenant identity mismatch");
    if (!existing) {
      this.ctx.storage.sql.exec(
        "INSERT INTO metadata (key, value) VALUES ('tenant_id', ?)",
        tenantId
      );
    }
  }

  async configureRetention(policy: ConversationRetentionPolicy, now: string): Promise<void> {
    validateConversationRetentionPolicy(policy);
    const nowMs = parseCanonicalIso(now, "retention configuration time");
    this.assertInitialized();
    const values: Array<[string, string]> = [
      ["retention_message_days", String(policy.messageRetentionDays)],
      ["retention_conversation_days", String(policy.inactiveConversationRetentionDays)],
      ["retention_pending_status_days", String(policy.pendingStatusRetentionDays)],
      ["retention_interval_hours", String(policy.pruneIntervalHours)]
    ];
    for (const [key, value] of values) {
      this.ctx.storage.sql.exec(
        `INSERT INTO metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value
      );
    }
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null) {
      await this.ctx.storage.setAlarm(nowMs + policy.pruneIntervalHours * 60 * 60 * 1000);
    }
  }

  async alarm(): Promise<void> {
    const policy = this.readRetentionPolicy();
    if (!policy) return;
    await this.runRetention(new Date().toISOString());
  }

  async runRetention(now: string): Promise<ConversationRetentionResult> {
    const nowMs = parseCanonicalIso(now, "retention run time");
    this.assertInitialized();
    const policy = this.readRetentionPolicy();
    if (!policy) throw new Error("Conversation retention is not configured");

    const messageCutoff = daysBefore(nowMs, policy.messageRetentionDays);
    const inactiveConversationCutoff = daysBefore(nowMs, policy.inactiveConversationRetentionDays);
    const pendingStatusCutoff = daysBefore(nowMs, policy.pendingStatusRetentionDays);

    const { messagesDeleted, pendingStatusesDeleted, conversationsDeleted } = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM attachment_chunks WHERE attachment_ref IN (
          SELECT attachment_ref FROM messages WHERE occurred_at < ? AND attachment_ref IS NOT NULL
        )`,
        messageCutoff
      );
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE occurred_at < ?", messageCutoff);
      const messagesDeleted = this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count").one().count;
      this.ctx.storage.sql.exec(
        "DELETE FROM pending_message_statuses WHERE occurred_at < ?",
        pendingStatusCutoff
      );
      const pendingStatusesDeleted = this.ctx.storage.sql
        .exec<CountRow>("SELECT changes() AS count").one().count;
      this.ctx.storage.sql.exec(
        `UPDATE conversations SET
           message_count = (
             SELECT COUNT(*) FROM messages
             WHERE messages.conversation_ref = conversations.conversation_ref
           ),
           unread_inbound_count = (
             SELECT COUNT(*) FROM messages
             WHERE messages.conversation_ref = conversations.conversation_ref
               AND messages.direction = 'inbound'
               AND messages.status = 'received'
           )`
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM conversation_template_consents WHERE conversation_ref IN (
           SELECT conversation_ref FROM conversations
           WHERE last_message_at < ? AND recipient_opted_out = 0 AND automation_paused = 0
             AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_ref = conversations.conversation_ref)
         )`,
        inactiveConversationCutoff
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM conversations
         WHERE last_message_at < ?
           AND recipient_opted_out = 0
           AND automation_paused = 0
           AND NOT EXISTS (
             SELECT 1 FROM messages
             WHERE messages.conversation_ref = conversations.conversation_ref
           )`,
        inactiveConversationCutoff
      );
      const conversationsDeleted = this.ctx.storage.sql
        .exec<CountRow>("SELECT changes() AS count").one().count;

      return { messagesDeleted, pendingStatusesDeleted, conversationsDeleted };
    });
    const nextRunAt = new Date(nowMs + policy.pruneIntervalHours * 60 * 60 * 1000).toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO metadata (key, value) VALUES ('retention_last_run_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      now
    );
    await this.ctx.storage.setAlarm(Date.parse(nextRunAt));
    return {
      ranAt: now,
      messageCutoff,
      inactiveConversationCutoff,
      pendingStatusCutoff,
      messagesDeleted,
      conversationsDeleted,
      pendingStatusesDeleted,
      nextRunAt
    };
  }

  async deleteConversationData(conversationRef: string): Promise<ConversationDeletionResult> {
    if (!conversationRef || conversationRef.length > 200) throw new Error("Invalid conversation reference");
    this.assertInitialized();
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM attachment_chunks WHERE attachment_ref IN (
          SELECT attachment_ref FROM messages WHERE conversation_ref = ? AND attachment_ref IS NOT NULL
        )`,
        conversationRef
      );
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE conversation_ref = ?", conversationRef);
      const messagesDeleted = this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count").one().count;
      this.ctx.storage.sql.exec("DELETE FROM conversation_template_consents WHERE conversation_ref = ?", conversationRef);
      this.ctx.storage.sql.exec("DELETE FROM conversations WHERE conversation_ref = ?", conversationRef);
      const conversationsDeleted = this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count").one().count;
      return { conversationsDeleted, messagesDeleted, pendingStatusesDeleted: 0 };
    });
  }

  async deleteAllConversationData(): Promise<ConversationDeletionResult> {
    this.assertInitialized();
    return this.ctx.storage.transactionSync(() => {
      const messagesDeleted = this.ctx.storage.sql.exec<CountRow>(
        "SELECT COUNT(*) AS count FROM messages"
      ).one().count;
      const conversationsDeleted = this.ctx.storage.sql.exec<CountRow>(
        "SELECT COUNT(*) AS count FROM conversations"
      ).one().count;
      const pendingStatusesDeleted = this.ctx.storage.sql.exec<CountRow>(
        "SELECT COUNT(*) AS count FROM pending_message_statuses"
      ).one().count;
      this.ctx.storage.sql.exec("DELETE FROM attachment_chunks");
      this.ctx.storage.sql.exec("DELETE FROM messages");
      this.ctx.storage.sql.exec("DELETE FROM pending_message_statuses");
      this.ctx.storage.sql.exec("DELETE FROM conversation_template_consents");
      this.ctx.storage.sql.exec("DELETE FROM conversations");
      return { conversationsDeleted, messagesDeleted, pendingStatusesDeleted };
    });
  }

  async registerConversation(input: {
    conversationRef: string;
    providerAccountRef: string;
    providerParticipantRef: string;
    displayName?: string;
    registeredAt: string;
  }): Promise<void> {
    if (!input.conversationRef || input.conversationRef.length > 200) throw new Error("Invalid conversation reference");
    if (!/^\d{3,32}$/u.test(input.providerAccountRef)) throw new Error("Invalid provider account reference");
    if (!/^\d{7,20}$/u.test(input.providerParticipantRef)) throw new Error("Invalid provider participant reference");
    if (input.displayName && input.displayName.length > 200) throw new Error("Invalid conversation display name");
    parseCanonicalIso(input.registeredAt, "conversation registration time");
    this.assertInitialized();
    this.ctx.storage.sql.exec(
      `INSERT INTO conversations (
        conversation_ref, provider_account_ref, provider_participant_ref,
        display_name, created_at, updated_at, last_message_at,
        message_count, unread_inbound_count, recipient_opted_out,
        automation_paused, policy_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'v1')
      ON CONFLICT(conversation_ref) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, conversations.display_name),
        updated_at = MAX(conversations.updated_at, excluded.updated_at)`,
      input.conversationRef,
      input.providerAccountRef,
      input.providerParticipantRef,
      input.displayName ?? null,
      input.registeredAt,
      input.registeredAt,
      input.registeredAt
    );
  }

  async ingestMessage(message: Omit<InternalConversationMessage, "tenantId">): Promise<void> {
    validateMessage(message);
    this.assertInitialized();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO conversations (
        conversation_ref, provider_account_ref, provider_participant_ref,
        display_name, created_at, updated_at, last_message_at,
        message_count, unread_inbound_count, recipient_opted_out,
        automation_paused, policy_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'v1')`,
      message.conversationRef,
      message.providerAccountRef,
      message.providerParticipantRef,
      message.displayName ?? null,
      message.occurredAt,
      message.occurredAt,
      message.occurredAt
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO messages (
        message_ref, conversation_ref, direction, kind, body_text,
        template_name, occurred_at, status, attachment_ref, attachment_kind,
        attachment_mime_type, attachment_sha256, attachment_caption,
        attachment_filename, attachment_size_bytes, attachment_state,
        provider_media_ref, media_storage_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.messageRef,
      message.conversationRef,
      message.direction,
      message.kind,
      message.text ?? null,
      message.templateName ?? null,
      message.occurredAt,
      message.status,
      message.attachment?.attachmentRef ?? null,
      message.attachment?.kind ?? null,
      message.attachment?.mimeType ?? null,
      message.attachment?.sha256 ?? null,
      message.attachment?.caption ?? null,
      message.attachment?.filename ?? null,
      message.attachment?.sizeBytes ?? null,
      message.attachment?.state ?? null,
      message.attachment?.providerMediaRef ?? null,
      message.attachment?.storageKey ?? null
    );
    const inserted = this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count").one().count;
    if (inserted !== 1) return;

    const inboundAt = message.direction === "inbound" ? message.occurredAt : null;
    const outboundAt = message.direction === "outbound" ? message.occurredAt : null;
    const unreadIncrement = message.direction === "inbound" ? 1 : 0;
    this.ctx.storage.sql.exec(
      `UPDATE conversations SET
        display_name = COALESCE(?, display_name),
        updated_at = MAX(updated_at, ?),
        last_message_at = MAX(last_message_at, ?),
        last_verified_user_inbound_at = CASE
          WHEN ? IS NULL THEN last_verified_user_inbound_at
          WHEN last_verified_user_inbound_at IS NULL THEN ?
          ELSE MAX(last_verified_user_inbound_at, ?)
        END,
        last_outbound_at = CASE
          WHEN ? IS NULL THEN last_outbound_at
          WHEN last_outbound_at IS NULL THEN ?
          ELSE MAX(last_outbound_at, ?)
        END,
        message_count = message_count + 1,
        unread_inbound_count = unread_inbound_count + ?
       WHERE conversation_ref = ?`,
      message.displayName ?? null,
      message.occurredAt,
      message.occurredAt,
      inboundAt,
      inboundAt,
      inboundAt,
      outboundAt,
      outboundAt,
      outboundAt,
      unreadIncrement,
      message.conversationRef
    );

    const pendingStatus = this.ctx.storage.sql
      .exec<{ status: WhatsAppMessageStatus }>(
        "SELECT status FROM pending_message_statuses WHERE message_ref = ?",
        message.messageRef
      )
      .toArray()[0];
    if (pendingStatus) {
      this.ctx.storage.sql.exec(
        "UPDATE messages SET status = ? WHERE message_ref = ?",
        laterStatus(message.status, pendingStatus.status),
        message.messageRef
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM pending_message_statuses WHERE message_ref = ?",
        message.messageRef
      );
    }
  }

  async updateMessageStatus(
    update: Omit<InternalMessageStatusUpdate, "tenantId">
  ): Promise<void> {
    parseCanonicalIso(update.occurredAt, "status timestamp");
    this.assertInitialized();
    const existing = this.ctx.storage.sql
      .exec<{ status: WhatsAppMessageStatus }>(
        "SELECT status FROM messages WHERE message_ref = ?",
        update.messageRef
      )
      .toArray()[0];
    if (existing) {
      this.ctx.storage.sql.exec(
        "UPDATE messages SET status = ? WHERE message_ref = ?",
        laterStatus(existing.status, update.status),
        update.messageRef
      );
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO pending_message_statuses (message_ref, status, occurred_at)
       VALUES (?, ?, ?)
       ON CONFLICT(message_ref) DO UPDATE SET
         status = excluded.status,
         occurred_at = MAX(pending_message_statuses.occurred_at, excluded.occurred_at)`,
      update.messageRef,
      update.status,
      update.occurredAt
    );
  }

  async updateAttachmentState(
    update: Omit<InternalAttachmentStateUpdate, "tenantId">
  ): Promise<void> {
    if (!/^att_[A-Za-z0-9_-]{32}$/u.test(update.attachmentRef)) {
      throw new Error("Invalid attachment reference");
    }
    if (update.storageKey && update.storageKey.length > 512) throw new Error("Invalid media storage key");
    if (update.sizeBytes !== undefined && (!Number.isInteger(update.sizeBytes) || update.sizeBytes < 0)) {
      throw new Error("Invalid attachment size");
    }
    if (update.sha256 && !/^[A-Za-z0-9+/]{43}=$/u.test(update.sha256)) {
      throw new Error("Invalid attachment hash");
    }
    this.assertInitialized();
    this.ctx.storage.sql.exec(
      `UPDATE messages SET attachment_state = ?, media_storage_key = COALESCE(?, media_storage_key),
        attachment_size_bytes = COALESCE(?, attachment_size_bytes),
        attachment_sha256 = COALESCE(?, attachment_sha256)
       WHERE conversation_ref = ? AND attachment_ref = ?`,
      update.state,
      update.storageKey ?? null,
      update.sizeBytes ?? null,
      update.sha256 ?? null,
      update.conversationRef,
      update.attachmentRef
    );
  }

  async getAttachment(
    conversationRef: string,
    attachmentRef: string
  ): Promise<InternalStoredAttachment | null> {
    if (!conversationRef || conversationRef.length > 200 || !/^att_[A-Za-z0-9_-]{32}$/u.test(attachmentRef)) {
      throw new Error("Invalid attachment lookup");
    }
    this.assertInitialized();
    const row = this.ctx.storage.sql.exec<MessageRow & { provider_account_ref: string }>(
      `SELECT m.message_ref, m.conversation_ref, m.direction, m.kind, m.body_text,
        m.template_name, m.occurred_at, m.status, m.attachment_ref, m.attachment_kind,
        m.attachment_mime_type, m.attachment_sha256, m.attachment_caption,
        m.attachment_filename, m.attachment_size_bytes, m.attachment_state,
        m.provider_media_ref, m.media_storage_key, c.provider_account_ref
       FROM messages m JOIN conversations c ON c.conversation_ref = m.conversation_ref
       WHERE m.conversation_ref = ? AND m.attachment_ref = ?`,
      conversationRef,
      attachmentRef
    ).toArray()[0];
    if (!row?.attachment_ref || !row.attachment_kind || !row.attachment_mime_type ||
        !row.attachment_state || !row.provider_media_ref) return null;
    return {
      attachmentRef: row.attachment_ref,
      conversationRef: row.conversation_ref,
      messageRef: row.message_ref,
      providerAccountRef: row.provider_account_ref,
      providerMediaRef: row.provider_media_ref,
      kind: row.attachment_kind,
      mimeType: row.attachment_mime_type,
      ...(row.attachment_sha256 ? { sha256: row.attachment_sha256 } : {}),
      ...(row.attachment_caption ? { caption: row.attachment_caption } : {}),
      ...(row.attachment_filename ? { filename: row.attachment_filename } : {}),
      ...(row.attachment_size_bytes !== null ? { sizeBytes: row.attachment_size_bytes } : {}),
      state: row.attachment_state,
      ...(row.media_storage_key ? { storageKey: row.media_storage_key } : {})
    };
  }

  async putAttachmentContent(
    conversationRef: string,
    attachmentRef: string,
    data: Uint8Array
  ): Promise<void> {
    if (!conversationRef || conversationRef.length > 200 || !/^att_[A-Za-z0-9_-]{32}$/u.test(attachmentRef)) {
      throw new Error("Invalid attachment content identity");
    }
    if (!(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("Invalid attachment content size");
    }
    this.assertInitialized();
    const exists = this.ctx.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_ref = ? AND attachment_ref = ?",
      conversationRef,
      attachmentRef
    ).one().count;
    if (exists !== 1) throw new Error("Attachment metadata was not found");
    this.ctx.storage.sql.exec("DELETE FROM attachment_chunks WHERE attachment_ref = ?", attachmentRef);
    for (let offset = 0, index = 0; offset < data.byteLength; offset += ATTACHMENT_CHUNK_BYTES, index += 1) {
      const chunk = data.slice(offset, Math.min(offset + ATTACHMENT_CHUNK_BYTES, data.byteLength));
      this.ctx.storage.sql.exec(
        "INSERT INTO attachment_chunks (attachment_ref, chunk_index, body) VALUES (?, ?, ?)",
        attachmentRef,
        index,
        chunk.buffer
      );
    }
  }

  async getAttachmentContent(conversationRef: string, attachmentRef: string): Promise<Uint8Array | null> {
    if (!conversationRef || conversationRef.length > 200 || !/^att_[A-Za-z0-9_-]{32}$/u.test(attachmentRef)) {
      throw new Error("Invalid attachment content lookup");
    }
    this.assertInitialized();
    const metadata = this.ctx.storage.sql.exec<{ attachment_size_bytes: number | null }>(
      `SELECT attachment_size_bytes FROM messages
       WHERE conversation_ref = ? AND attachment_ref = ? AND attachment_state = 'ready'`,
      conversationRef,
      attachmentRef
    ).toArray()[0];
    if (!metadata) return null;
    const rows = this.ctx.storage.sql.exec<{ body: ArrayBuffer | Uint8Array }>(
      "SELECT body FROM attachment_chunks WHERE attachment_ref = ? ORDER BY chunk_index ASC",
      attachmentRef
    ).toArray();
    if (rows.length === 0) return null;
    const chunks = rows.map((row) => row.body instanceof Uint8Array ? row.body : new Uint8Array(row.body));
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (total < 1 || total > MAX_ATTACHMENT_BYTES ||
        (metadata.attachment_size_bytes !== null && total !== metadata.attachment_size_bytes)) {
      throw new Error("Stored attachment content is inconsistent");
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  async updatePolicyState(
    patch: Omit<InternalConversationPolicyPatch, "tenantId">
  ): Promise<void> {
    if (!patch.conversationRef || !patch.policyRevision) throw new Error("Invalid policy-state update");
    this.assertInitialized();
    this.ctx.storage.sql.exec(
      `UPDATE conversations SET
         recipient_opted_out = COALESCE(?, recipient_opted_out),
         automation_paused = COALESCE(?, automation_paused),
         policy_revision = ?,
         updated_at = ?
       WHERE conversation_ref = ?`,
      patch.recipientOptedOut === undefined ? null : Number(patch.recipientOptedOut),
      patch.automationPaused === undefined ? null : Number(patch.automationPaused),
      patch.policyRevision,
      new Date().toISOString(),
      patch.conversationRef
    );
  }

  async markConversationRead(conversationRef: string, readAt: string): Promise<void> {
    parseCanonicalIso(readAt, "read timestamp");
    this.assertInitialized();
    this.ctx.storage.sql.exec(
      `UPDATE conversations SET
         unread_inbound_count = 0,
         updated_at = MAX(updated_at, ?)
       WHERE conversation_ref = ?`,
      readAt,
      conversationRef
    );
  }

  async getConversationEnforcementState(
    conversationRef: string
  ): Promise<InternalConversationEnforcementState | null> {
    this.assertInitialized();
    const row = this.ctx.storage.sql.exec<InternalConversationRow>(
      `SELECT conversation_ref, provider_account_ref, provider_participant_ref,
        display_name, created_at, updated_at, last_message_at,
        last_verified_user_inbound_at, last_outbound_at, message_count,
        unread_inbound_count, recipient_opted_out, automation_paused,
        policy_revision
       FROM conversations WHERE conversation_ref = ?`,
      conversationRef
    ).toArray()[0];
    if (!row) return null;
    return {
      conversationRef: row.conversation_ref,
      providerAccountRef: row.provider_account_ref,
      providerParticipantRef: row.provider_participant_ref,
      ...(row.last_verified_user_inbound_at
        ? { lastVerifiedUserInboundAt: row.last_verified_user_inbound_at }
        : {}),
      ...(row.last_outbound_at ? { lastOutboundAt: row.last_outbound_at } : {}),
      recipientOptedOut: row.recipient_opted_out === 1,
      automationPaused: row.automation_paused === 1,
      policyRevision: row.policy_revision
    };
  }

  async reserveOutboundDispatch(input: OutboundDispatchReservation): Promise<OutboundDispatchReservationResult> {
    validateDispatchInput(input);
    this.assertInitialized();
    const existing = this.readOutboundDispatchResult(input);
    if (existing) return existing;
    const conversation = this.ctx.storage.sql.exec<InternalConversationRow>(
      "SELECT * FROM conversations WHERE conversation_ref = ?",
      input.conversationRef
    ).toArray()[0];
    if (!conversation || conversation.policy_revision !== input.expectedPolicyRevision ||
        (input.expectedProviderAccountRef !== undefined && conversation.provider_account_ref !== input.expectedProviderAccountRef)) {
      return { status: "blocked", reason: "state_changed" };
    }
    if (conversation.recipient_opted_out === 1) return { status: "blocked", reason: "recipient_opted_out" };
    if (conversation.automation_paused === 1) return { status: "blocked", reason: "automation_paused" };
    if (input.kind === "approved_template") {
      const template = input.template;
      if (!template) return { status: "blocked", reason: "template_unavailable" };
      const current = this.ctx.storage.sql.exec<{
        category: string; purpose: string; language_code: string; enabled: number;
      }>("SELECT category, purpose, language_code, enabled FROM approved_templates WHERE name = ?", template.name).toArray()[0];
      if (!current || current.enabled !== 1) return { status: "blocked", reason: "template_unavailable" };
      if (current.category !== template.category || current.purpose !== template.purpose || current.language_code !== template.languageCode) {
        return { status: "blocked", reason: "state_changed" };
      }
      const consent = this.ctx.storage.sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM conversation_template_consents WHERE conversation_ref = ?
         AND ((consent_type = 'category' AND consent_value = ?) OR (consent_type = 'purpose' AND consent_value = ?))`,
        input.conversationRef, current.category, current.purpose
      ).one();
      if (consent.count !== 2) return { status: "blocked", reason: "template_consent_required" };
    }
    if (input.kind === "free_form_reply") {
      if (!input.notAfter || input.now >= input.notAfter ||
          !conversation.last_verified_user_inbound_at ||
          input.now >= new Date(Date.parse(conversation.last_verified_user_inbound_at) + 24 * 60 * 60 * 1000).toISOString()) {
        return { status: "blocked", reason: "window_closed" };
      }
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO outbound_dispatches
       (idempotency_key, request_fingerprint, conversation_ref, kind, status, reserved_at)
       VALUES (?, ?, ?, ?, 'reserved', ?)`,
      input.idempotencyKey, input.requestFingerprint, input.conversationRef, input.kind, input.now
    );
    return {
      status: "ready",
      providerAccountRef: conversation.provider_account_ref,
      providerParticipantRef: conversation.provider_participant_ref
    };
  }

  async getOutboundDispatchResult(input: { idempotencyKey: string; requestFingerprint: string }) {
    this.assertInitialized();
    return this.readOutboundDispatchResult(input);
  }

  /** Only the holder of a ready reservation may cancel, and only before provider I/O. */
  async cancelUnsentOutboundDispatch(input: { idempotencyKey: string; requestFingerprint: string }): Promise<void> {
    this.assertInitialized();
    this.ctx.storage.sql.exec(
      "DELETE FROM outbound_dispatches WHERE idempotency_key = ? AND request_fingerprint = ? AND status = 'reserved'",
      input.idempotencyKey, input.requestFingerprint
    );
  }

  private readOutboundDispatchResult(input: { idempotencyKey: string; requestFingerprint: string }): Exclude<OutboundDispatchReservationResult, { status: "ready" }> | null {
    const existing = this.ctx.storage.sql.exec<{
      request_fingerprint: string;
      status: "reserved" | "sent";
      message_ref: string | null;
      provider_status: "accepted" | "queued" | "sent" | null;
    }>(
      `SELECT request_fingerprint, status, message_ref, provider_status
       FROM outbound_dispatches WHERE idempotency_key = ?`,
      input.idempotencyKey
    ).toArray()[0];
    if (existing) {
      if (existing.request_fingerprint !== input.requestFingerprint) {
        return { status: "blocked", reason: "state_changed" };
      }
      if (existing.status === "sent" && existing.message_ref && existing.provider_status) {
        return { status: "duplicate", messageRef: existing.message_ref, providerStatus: existing.provider_status };
      }
      return { status: "blocked", reason: "in_progress" };
    }
    return null;
  }

  async completeOutboundDispatch(input: OutboundDispatchCompletion): Promise<void> {
    const reservation = this.ctx.storage.sql.exec<{ request_fingerprint: string; status: string }>(
      "SELECT request_fingerprint, status FROM outbound_dispatches WHERE idempotency_key = ?",
      input.idempotencyKey
    ).toArray()[0];
    if (!reservation || reservation.status !== "reserved" || reservation.request_fingerprint !== input.requestFingerprint) {
      throw new Error("Outbound reservation is unavailable");
    }
    await this.ingestMessage({
      conversationRef: input.conversationRef,
      providerAccountRef: input.providerAccountRef,
      providerParticipantRef: input.providerParticipantRef,
      messageRef: input.messageRef,
      direction: "outbound",
      kind: input.kind,
      ...(input.text ? { text: input.text } : {}),
      ...(input.templateName ? { templateName: input.templateName } : {}),
      occurredAt: input.occurredAt,
      status: input.providerStatus === "queued" ? "accepted" : input.providerStatus
    });
    this.ctx.storage.sql.exec(
      `UPDATE outbound_dispatches SET status = 'sent', message_ref = ?, provider_status = ?, completed_at = ?
       WHERE idempotency_key = ? AND request_fingerprint = ? AND status = 'reserved'`,
      input.messageRef,
      input.providerStatus,
      input.occurredAt,
      input.idempotencyKey,
      input.requestFingerprint
    );
  }

  async getOutboundPolicy(conversationRef: string) {
    if (!conversationRef || conversationRef.length > 200) throw new Error("Invalid conversation reference");
    this.assertInitialized();
    const templates = this.ctx.storage.sql.exec<{
      name: string;
      category: string;
      purpose: string;
      language_code: string;
      enabled: number;
    }>(
      "SELECT name, category, purpose, language_code, enabled FROM approved_templates ORDER BY name"
    ).toArray();
    const consents = this.ctx.storage.sql.exec<{ consent_type: "category" | "purpose"; consent_value: string }>(
      `SELECT consent_type, consent_value FROM conversation_template_consents
       WHERE conversation_ref = ? ORDER BY consent_type, consent_value`,
      conversationRef
    ).toArray();
    return {
      approvedTemplates: templates.map((template) => ({
        name: template.name,
        category: template.category,
        purpose: template.purpose,
        languageCode: template.language_code,
        enabled: template.enabled === 1
      })),
      consentedTemplateCategories: consents.filter((item) => item.consent_type === "category").map((item) => item.consent_value),
      consentedTemplatePurposes: consents.filter((item) => item.consent_type === "purpose").map((item) => item.consent_value)
    };
  }

  async upsertApprovedTemplate(template: {
    name: string;
    category: string;
    purpose: string;
    languageCode: string;
    enabled: boolean;
  }): Promise<void> {
    this.assertInitialized();
    for (const value of [template.name, template.category, template.purpose, template.languageCode]) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(value)) throw new Error("Invalid template policy value");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO approved_templates (name, category, purpose, language_code, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET category = excluded.category, purpose = excluded.purpose,
       language_code = excluded.language_code, enabled = excluded.enabled`,
      template.name,
      template.category,
      template.purpose,
      template.languageCode,
      Number(template.enabled)
    );
  }

  async setConversationTemplateConsent(input: {
    conversationRef: string;
    categories: string[];
    purposes: string[];
    policyRevision: string;
    updatedAt: string;
  }): Promise<void> {
    this.assertInitialized();
    parseCanonicalIso(input.updatedAt, "consent update time");
    if (!input.conversationRef || !input.policyRevision || input.categories.length > 20 || input.purposes.length > 20) {
      throw new Error("Invalid template consent policy");
    }
    const conversation = this.ctx.storage.sql.exec<{ conversation_ref: string }>(
      "SELECT conversation_ref FROM conversations WHERE conversation_ref = ?",
      input.conversationRef
    ).toArray()[0];
    if (!conversation) throw new Error("Conversation is unavailable");
    const values = [
      ...new Set(input.categories.map((value) => `category\u0000${value}`)),
      ...new Set(input.purposes.map((value) => `purpose\u0000${value}`))
    ];
    for (const entry of values) {
      const value = entry.slice(entry.indexOf("\u0000") + 1);
      if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(value)) throw new Error("Invalid consent policy value");
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM conversation_template_consents WHERE conversation_ref = ?",
      input.conversationRef
    );
    for (const entry of values) {
      const [type, value] = entry.split("\u0000");
      this.ctx.storage.sql.exec(
        `INSERT INTO conversation_template_consents (conversation_ref, consent_type, consent_value)
         VALUES (?, ?, ?)`,
        input.conversationRef,
        type,
        value
      );
    }
    this.ctx.storage.sql.exec(
      "UPDATE conversations SET policy_revision = ?, updated_at = ? WHERE conversation_ref = ?",
      input.policyRevision,
      input.updatedAt,
      input.conversationRef
    );
  }

  async pruneMessages(occurredBefore: string): Promise<number> {
    parseCanonicalIso(occurredBefore, "retention cutoff");
    this.assertInitialized();
    this.ctx.storage.sql.exec(
      `DELETE FROM attachment_chunks WHERE attachment_ref IN (
        SELECT attachment_ref FROM messages WHERE occurred_at < ? AND attachment_ref IS NOT NULL
      )`,
      occurredBefore
    );
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE occurred_at < ?", occurredBefore);
    const removed = this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count").one().count;
    this.ctx.storage.sql.exec(
      `UPDATE conversations SET message_count = (
         SELECT COUNT(*) FROM messages WHERE messages.conversation_ref = conversations.conversation_ref
       ), unread_inbound_count = (
         SELECT COUNT(*) FROM messages
         WHERE messages.conversation_ref = conversations.conversation_ref
           AND messages.direction = 'inbound'
           AND messages.status = 'received'
       )`
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM pending_message_statuses WHERE occurred_at < ?",
      occurredBefore
    );
    return removed;
  }

  private readRetentionPolicy(): ConversationRetentionPolicy | null {
    const rows = this.ctx.storage.sql.exec<{ key: string; value: string }>(
      "SELECT key, value FROM metadata WHERE key LIKE 'retention_%'"
    ).toArray();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const required = [
      "retention_message_days",
      "retention_conversation_days",
      "retention_pending_status_days",
      "retention_interval_hours"
    ];
    if (!required.every((key) => values.has(key))) return null;
    const policy = {
      messageRetentionDays: Number(values.get("retention_message_days")),
      inactiveConversationRetentionDays: Number(values.get("retention_conversation_days")),
      pendingStatusRetentionDays: Number(values.get("retention_pending_status_days")),
      pruneIntervalHours: Number(values.get("retention_interval_hours"))
    };
    validateConversationRetentionPolicy(policy);
    return policy;
  }

  async listConversations(query: ConversationListQuery): Promise<ConversationListResult> {
    this.assertInitialized();
    const limit = boundedLimit(query.limit, DEFAULT_CONVERSATION_PAGE_SIZE, MAX_CONVERSATION_PAGE_SIZE);
    const cursor = decodeCursor(query.cursor);
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (query.updatedAfter) {
      const parsed = new Date(query.updatedAfter);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== query.updatedAfter) {
        throw new Error("Invalid updatedAfter timestamp");
      }
      conditions.push("updated_at > ?");
      bindings.push(query.updatedAfter);
    }
    if (cursor) {
      conditions.push("(updated_at < ? OR (updated_at = ? AND conversation_ref < ?))");
      bindings.push(cursor.timestamp, cursor.timestamp, cursor.reference);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.ctx.storage.sql.exec<ConversationRow>(
      `SELECT conversation_ref, display_name, created_at, updated_at,
        last_message_at, last_verified_user_inbound_at, last_outbound_at,
        message_count, unread_inbound_count, recipient_opted_out,
        automation_paused, policy_revision
       FROM conversations ${where}
       ORDER BY updated_at DESC, conversation_ref DESC LIMIT ?`,
      ...bindings,
      limit + 1
    ).toArray();
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page.at(-1) : undefined;
    return {
      conversations: page.map((row) => summarizeConversation(mapConversation(row), new Date())),
      ...(next ? { nextCursor: encodeCursor(next.updated_at, next.conversation_ref) } : {})
    };
  }

  async getConversationHistory(
    query: ConversationHistoryQuery
  ): Promise<ConversationHistoryResult | null> {
    this.assertInitialized();
    const conversationRow = this.ctx.storage.sql.exec<ConversationRow>(
      `SELECT conversation_ref, display_name, created_at, updated_at,
        last_message_at, last_verified_user_inbound_at, last_outbound_at,
        message_count, unread_inbound_count, recipient_opted_out,
        automation_paused, policy_revision
       FROM conversations WHERE conversation_ref = ?`,
      query.conversationRef
    ).toArray()[0];
    if (!conversationRow) return null;

    const limit = boundedLimit(query.limit, DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE);
    const cursor = decodeCursor(query.cursor);
    const cursorSql = cursor
      ? "AND (occurred_at < ? OR (occurred_at = ? AND message_ref < ?))"
      : "";
    const cursorBindings = cursor
      ? [cursor.timestamp, cursor.timestamp, cursor.reference]
      : [];
    const rows = this.ctx.storage.sql.exec<MessageRow>(
      `SELECT message_ref, conversation_ref, direction, kind, body_text,
        template_name, occurred_at, status, attachment_ref, attachment_kind,
        attachment_mime_type, attachment_sha256, attachment_caption,
        attachment_filename, attachment_size_bytes, attachment_state,
        provider_media_ref, media_storage_key
       FROM messages WHERE conversation_ref = ? ${cursorSql}
       ORDER BY occurred_at DESC, message_ref DESC LIMIT ?`,
      query.conversationRef,
      ...cursorBindings,
      limit + 1
    ).toArray();
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page.at(-1) : undefined;
    return {
      conversation: summarizeConversation(mapConversation(conversationRow), new Date()),
      messages: page.map(mapMessage),
      ...(next ? { nextCursor: encodeCursor(next.occurred_at, next.message_ref) } : {})
    };
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const currentVersion = this.ctx.storage.sql
      .exec<VersionRow>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations"
      )
      .one().version;
    if (currentVersion < 1) this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_ref TEXT PRIMARY KEY,
        provider_account_ref TEXT NOT NULL,
        provider_participant_ref TEXT NOT NULL,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        last_verified_user_inbound_at TEXT,
        last_outbound_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        unread_inbound_count INTEGER NOT NULL DEFAULT 0,
        recipient_opted_out INTEGER NOT NULL DEFAULT 0,
        automation_paused INTEGER NOT NULL DEFAULT 0,
        policy_revision TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_updated
        ON conversations(updated_at DESC, conversation_ref DESC);
      CREATE TABLE IF NOT EXISTS messages (
        message_ref TEXT PRIMARY KEY,
        conversation_ref TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        kind TEXT NOT NULL,
        body_text TEXT,
        template_name TEXT,
        occurred_at TEXT NOT NULL,
        status TEXT NOT NULL,
        FOREIGN KEY(conversation_ref) REFERENCES conversations(conversation_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
        ON messages(conversation_ref, occurred_at DESC, message_ref DESC);
      CREATE TABLE IF NOT EXISTS pending_message_statuses (
        message_ref TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      INSERT INTO _sql_schema_migrations (id) VALUES (1);
    `);
    if (currentVersion < 2) this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS outbound_dispatches (
        idempotency_key TEXT PRIMARY KEY,
        request_fingerprint TEXT NOT NULL,
        conversation_ref TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('free_form_reply', 'approved_template')),
        status TEXT NOT NULL CHECK(status IN ('reserved', 'sent')),
        reserved_at TEXT NOT NULL,
        completed_at TEXT,
        message_ref TEXT,
        provider_status TEXT
      );
      INSERT INTO _sql_schema_migrations (id) VALUES (2);
    `);
    if (currentVersion < 3) this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS approved_templates (
        name TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        purpose TEXT NOT NULL,
        language_code TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS conversation_template_consents (
        conversation_ref TEXT NOT NULL,
        consent_type TEXT NOT NULL CHECK(consent_type IN ('category', 'purpose')),
        consent_value TEXT NOT NULL,
        PRIMARY KEY (conversation_ref, consent_type, consent_value),
        FOREIGN KEY(conversation_ref) REFERENCES conversations(conversation_ref)
      );
      INSERT INTO _sql_schema_migrations (id) VALUES (3);
    `);
    if (currentVersion < 4) this.ctx.storage.sql.exec(`
      ALTER TABLE messages ADD COLUMN attachment_ref TEXT;
      ALTER TABLE messages ADD COLUMN attachment_kind TEXT;
      ALTER TABLE messages ADD COLUMN attachment_mime_type TEXT;
      ALTER TABLE messages ADD COLUMN attachment_sha256 TEXT;
      ALTER TABLE messages ADD COLUMN attachment_caption TEXT;
      ALTER TABLE messages ADD COLUMN attachment_filename TEXT;
      ALTER TABLE messages ADD COLUMN attachment_size_bytes INTEGER;
      ALTER TABLE messages ADD COLUMN attachment_state TEXT;
      ALTER TABLE messages ADD COLUMN provider_media_ref TEXT;
      ALTER TABLE messages ADD COLUMN media_storage_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_attachment_ref
        ON messages(attachment_ref) WHERE attachment_ref IS NOT NULL;
      INSERT INTO _sql_schema_migrations (id) VALUES (4);
    `);
    if (currentVersion < 5) this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS attachment_chunks (
        attachment_ref TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        body BLOB NOT NULL,
        PRIMARY KEY (attachment_ref, chunk_index)
      );
      INSERT INTO _sql_schema_migrations (id) VALUES (5);
    `);
  }

  private assertInitialized(): void {
    const row = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM metadata WHERE key = 'tenant_id'")
      .one();
    if (row.count !== 1) throw new Error("Conversation store is not tenant-initialized");
  }
}

function validateDispatchInput(input: OutboundDispatchReservation): void {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(input.idempotencyKey)) throw new Error("Invalid idempotency key");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(input.requestFingerprint)) throw new Error("Invalid request fingerprint");
  parseCanonicalIso(input.now, "dispatch time");
  if (input.notAfter) parseCanonicalIso(input.notAfter, "dispatch deadline");
  if (!input.conversationRef || !input.expectedPolicyRevision) throw new Error("Invalid outbound dispatch");
}

export function createDurableConversationReader(
  namespace: DurableConversationNamespace,
  retentionPolicy?: ConversationRetentionPolicy
): WhatsAppConversationReader {
  return {
    async listConversations(principal, query) {
      const stub = await initializedStub(namespace, principal.tenantId, retentionPolicy);
      return stub.listConversations(query);
    },
    async getConversationHistory(principal, query) {
      const stub = await initializedStub(namespace, principal.tenantId, retentionPolicy);
      return stub.getConversationHistory(query);
    }
  };
}

export function createDurableConversationWriter(
  namespace: DurableConversationNamespace,
  retentionPolicy?: ConversationRetentionPolicy
): WhatsAppConversationWriter {
  return {
    async ingestMessage(message) {
      const stub = await initializedStub(namespace, message.tenantId, retentionPolicy);
      const { tenantId: _tenantId, ...record } = message;
      await stub.ingestMessage(record);
    },
    async updateMessageStatus(update) {
      const stub = await initializedStub(namespace, update.tenantId, retentionPolicy);
      const { tenantId: _tenantId, ...record } = update;
      await stub.updateMessageStatus(record);
    },
    async updateAttachmentState(update) {
      const stub = await initializedStub(namespace, update.tenantId, retentionPolicy);
      const { tenantId: _tenantId, ...record } = update;
      await stub.updateAttachmentState(record);
    },
    async updatePolicyState(patch) {
      const stub = await initializedStub(namespace, patch.tenantId, retentionPolicy);
      const { tenantId: _tenantId, ...record } = patch;
      await stub.updatePolicyState(record);
    },
    async markConversationRead(tenantId, conversationRef, readAt) {
      const stub = await initializedStub(namespace, tenantId, retentionPolicy);
      await stub.markConversationRead(conversationRef, readAt);
    },
    async pruneMessages(tenantId, occurredBefore) {
      const stub = await initializedStub(namespace, tenantId, retentionPolicy);
      return stub.pruneMessages(occurredBefore);
    }
  };
}

export function createDurableConversationEnforcementReader(
  namespace: DurableConversationNamespace
): WhatsAppConversationEnforcementReader {
  return {
    async getConversationEnforcementState(tenantId, conversationRef) {
      const stub = namespace.getByName(tenantId);
      await stub.initializeTenant(tenantId);
      return stub.getConversationEnforcementState(conversationRef);
    }
  };
}

export function createDurableAttachmentReader(
  namespace: DurableConversationNamespace
): WhatsAppAttachmentReader {
  return {
    async getAttachment(tenantId, conversationRef, attachmentRef) {
      const stub = namespace.getByName(tenantId);
      await stub.initializeTenant(tenantId);
      return stub.getAttachment(conversationRef, attachmentRef);
    }
  };
}

export function createDurableAttachmentContentStore(
  namespace: DurableConversationNamespace
): WhatsAppAttachmentContentStore {
  return {
    async putAttachmentContent(tenantId, conversationRef, attachmentRef, data) {
      const stub = namespace.getByName(tenantId);
      await stub.initializeTenant(tenantId);
      await stub.putAttachmentContent(conversationRef, attachmentRef, data);
    }
  };
}

export function createDurableAttachmentContentReader(
  namespace: DurableConversationNamespace,
  maximumBytes = MAX_ATTACHMENT_BYTES
): WhatsAppAttachmentContentReader {
  const metadata = createDurableAttachmentReader(namespace);
  return {
    async getAttachmentContent(principal, conversationRef, attachmentRef) {
      const record = await metadata.getAttachment(principal.tenantId, conversationRef, attachmentRef);
      if (!record || record.state !== "ready") return null;
      const stub = namespace.getByName(principal.tenantId);
      await stub.initializeTenant(principal.tenantId);
      const data = await stub.getAttachmentContent(conversationRef, attachmentRef);
      if (!data) return null;
      if (data.byteLength > maximumBytes) throw new Error("Stored attachment exceeds the MCP response limit");
      return {
        attachment: {
          attachmentRef: record.attachmentRef,
          kind: record.kind,
          mimeType: record.mimeType,
          ...(record.sha256 ? { sha256: record.sha256 } : {}),
          ...(record.caption ? { caption: record.caption } : {}),
          ...(record.filename ? { filename: record.filename } : {}),
          sizeBytes: data.byteLength,
          state: record.state
        },
        data
      };
    }
  };
}

export function createDurableConversationRetentionController(
  namespace: DurableConversationNamespace
) {
  return {
    async configure(tenantId: string, policy: ConversationRetentionPolicy, now = new Date().toISOString()) {
      const stub = namespace.getByName(tenantId);
      await stub.initializeTenant(tenantId);
      await stub.configureRetention(policy, now);
    },
    async run(tenantId: string, now = new Date().toISOString()) {
      const stub = namespace.getByName(tenantId);
      await stub.initializeTenant(tenantId);
      return stub.runRetention(now);
    },
    async deleteConversation(tenantId: string, conversationRef: string) {
      const stub = namespace.getByName(tenantId);
      await stub.initializeTenant(tenantId);
      return stub.deleteConversationData(conversationRef);
    },
    async deleteAllConversationData(tenantId: string) {
      const stub = namespace.getByName(tenantId);
      await stub.initializeTenant(tenantId);
      return stub.deleteAllConversationData();
    }
  };
}

function mapConversation(row: ConversationRow): StoredConversation {
  return {
    conversationRef: row.conversation_ref,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    ...(row.last_verified_user_inbound_at
      ? { lastVerifiedUserInboundAt: row.last_verified_user_inbound_at }
      : {}),
    ...(row.last_outbound_at ? { lastOutboundAt: row.last_outbound_at } : {}),
    messageCount: row.message_count,
    unreadInboundCount: row.unread_inbound_count,
    recipientOptedOut: row.recipient_opted_out === 1,
    automationPaused: row.automation_paused === 1,
    policyRevision: row.policy_revision
  };
}

function mapMessage(row: MessageRow): StoredConversationMessage {
  return {
    messageRef: row.message_ref,
    conversationRef: row.conversation_ref,
    direction: row.direction,
    kind: row.kind,
    ...(row.body_text ? { text: row.body_text } : {}),
    ...(row.template_name ? { templateName: row.template_name } : {}),
    ...(row.attachment_ref && row.attachment_kind && row.attachment_mime_type && row.attachment_state ? {
      attachment: {
        attachmentRef: row.attachment_ref,
        kind: row.attachment_kind,
        mimeType: row.attachment_mime_type,
        ...(row.attachment_sha256 ? { sha256: row.attachment_sha256 } : {}),
        ...(row.attachment_caption ? { caption: row.attachment_caption } : {}),
        ...(row.attachment_filename ? { filename: row.attachment_filename } : {}),
        ...(row.attachment_size_bytes !== null ? { sizeBytes: row.attachment_size_bytes } : {}),
        state: row.attachment_state
      }
    } : {}),
    occurredAt: row.occurred_at,
    status: row.status
  };
}

function validateMessage(message: Omit<InternalConversationMessage, "tenantId">): void {
  if (!message.messageRef || message.messageRef.length > 512) throw new Error("Invalid message reference");
  if (!message.conversationRef || message.conversationRef.length > 200) throw new Error("Invalid conversation reference");
  if (message.text && message.text.length > 4096) throw new Error("Message text exceeds storage limit");
  if (message.attachment) {
    if (!/^att_[A-Za-z0-9_-]{32}$/u.test(message.attachment.attachmentRef)) {
      throw new Error("Invalid attachment reference");
    }
    if (!/^\d{3,64}$/u.test(message.attachment.providerMediaRef)) {
      throw new Error("Invalid provider media reference");
    }
    if (!/^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/iu.test(message.attachment.mimeType)) {
      throw new Error("Invalid attachment MIME type");
    }
    if (message.attachment.caption && message.attachment.caption.length > 4096) {
      throw new Error("Attachment caption exceeds storage limit");
    }
    if (message.attachment.filename && message.attachment.filename.length > 255) {
      throw new Error("Attachment filename exceeds storage limit");
    }
  }
  parseCanonicalIso(message.occurredAt, "message timestamp");
}

function parseCanonicalIso(value: string, label: string): number {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed.getTime();
}

function daysBefore(nowMs: number, days: number): string {
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

async function initializedStub(
  namespace: DurableConversationNamespace,
  tenantId: string,
  retentionPolicy?: ConversationRetentionPolicy
): Promise<DurableConversationObjectStub> {
  const stub = namespace.getByName(tenantId);
  await stub.initializeTenant(tenantId);
  if (retentionPolicy) {
    await stub.configureRetention(retentionPolicy, new Date().toISOString());
  }
  return stub;
}

const statusOrder: Record<WhatsAppMessageStatus, number> = {
  received: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5
};

function laterStatus(current: WhatsAppMessageStatus, candidate: WhatsAppMessageStatus) {
  return statusOrder[candidate] >= statusOrder[current] ? candidate : current;
}
