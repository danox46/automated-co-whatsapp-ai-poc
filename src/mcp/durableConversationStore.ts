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
  type InternalMessageStatusUpdate,
  type StoredConversation,
  type StoredConversationMessage,
  type WhatsAppConversationReader,
  type WhatsAppConversationEnforcementReader,
  type WhatsAppConversationWriter,
  type WhatsAppMessageStatus
} from "./conversationHistory.js";
import {
  validateConversationRetentionPolicy,
  type ConversationRetentionPolicy
} from "./retentionPolicy.js";

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
  ingestMessage(message: Omit<InternalConversationMessage, "tenantId">): Promise<void>;
  updateMessageStatus(update: Omit<InternalMessageStatusUpdate, "tenantId">): Promise<void>;
  updatePolicyState(patch: Omit<InternalConversationPolicyPatch, "tenantId">): Promise<void>;
  markConversationRead(conversationRef: string, readAt: string): Promise<void>;
  getConversationEnforcementState(
    conversationRef: string
  ): Promise<InternalConversationEnforcementState | null>;
  configureRetention(policy: ConversationRetentionPolicy, now: string): Promise<void>;
  runRetention(now: string): Promise<ConversationRetentionResult>;
  deleteConversationData(conversationRef: string): Promise<ConversationDeletionResult>;
  deleteAllConversationData(): Promise<ConversationDeletionResult>;
  pruneMessages(occurredBefore: string): Promise<number>;
  listConversations(query: ConversationListQuery): Promise<ConversationListResult>;
  getConversationHistory(query: ConversationHistoryQuery): Promise<ConversationHistoryResult | null>;
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
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE conversation_ref = ?", conversationRef);
    const messagesDeleted = this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count").one().count;
    this.ctx.storage.sql.exec("DELETE FROM conversations WHERE conversation_ref = ?", conversationRef);
    const conversationsDeleted = this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count").one().count;
    return { conversationsDeleted, messagesDeleted, pendingStatusesDeleted: 0 };
  }

  async deleteAllConversationData(): Promise<ConversationDeletionResult> {
    this.assertInitialized();
    const messagesDeleted = this.ctx.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM messages"
    ).one().count;
    const conversationsDeleted = this.ctx.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM conversations"
    ).one().count;
    const pendingStatusesDeleted = this.ctx.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM pending_message_statuses"
    ).one().count;
    this.ctx.storage.sql.exec("DELETE FROM messages");
    this.ctx.storage.sql.exec("DELETE FROM pending_message_statuses");
    this.ctx.storage.sql.exec("DELETE FROM conversations");
    return { conversationsDeleted, messagesDeleted, pendingStatusesDeleted };
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
        template_name, occurred_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      message.messageRef,
      message.conversationRef,
      message.direction,
      message.kind,
      message.text ?? null,
      message.templateName ?? null,
      message.occurredAt,
      message.status
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

  async pruneMessages(occurredBefore: string): Promise<number> {
    parseCanonicalIso(occurredBefore, "retention cutoff");
    this.assertInitialized();
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
        template_name, occurred_at, status
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
    if (currentVersion >= 1) return;

    this.ctx.storage.sql.exec(`
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
  }

  private assertInitialized(): void {
    const row = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM metadata WHERE key = 'tenant_id'")
      .one();
    if (row.count !== 1) throw new Error("Conversation store is not tenant-initialized");
  }
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
    occurredAt: row.occurred_at,
    status: row.status
  };
}

function validateMessage(message: Omit<InternalConversationMessage, "tenantId">): void {
  if (!message.messageRef || message.messageRef.length > 512) throw new Error("Invalid message reference");
  if (!message.conversationRef || message.conversationRef.length > 200) throw new Error("Invalid conversation reference");
  if (message.text && message.text.length > 4096) throw new Error("Message text exceeds storage limit");
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
