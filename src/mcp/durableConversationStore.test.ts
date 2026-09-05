import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DurableObjectState, SqlStorageValue } from "cloudflare:workers";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: DurableObjectState;
    protected readonly env: unknown;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }
}));

let ConversationObject: typeof import("./durableConversationStore.js").WhatsAppConversationDurableObject;
let retentionPolicyFromEnv: typeof import("./persistentWorker.js").conversationRetentionPolicyFromEnv;
const sqliteModule = await import("node:sqlite").catch(() => null);
const describeWithSqlite = sqliteModule ? describe : describe.skip;

beforeAll(async () => {
  ({ WhatsAppConversationDurableObject: ConversationObject } = await import("./durableConversationStore.js"));
  ({ conversationRetentionPolicyFromEnv: retentionPolicyFromEnv } = await import("./persistentWorker.js"));
});

type TestDurableObjectState = DurableObjectState & { scheduledAlarm(): number | null };

function contextFor(database: DatabaseSyncType): TestDurableObjectState {
  let alarm: number | null = null;
  return {
    storage: {
      sql: {
        exec<T>(query: string, ...bindings: SqlStorageValue[]) {
          let rows: T[] = [];
          if (bindings.length === 0 && query.includes(";")) {
            database.exec(query);
          } else {
            rows = database.prepare(query).all(...bindings) as T[];
          }
          return {
            *[Symbol.iterator]() { yield* rows; },
            toArray: () => [...rows],
            one: () => {
              if (rows.length !== 1) throw new Error(`Expected one row, received ${rows.length}`);
              return rows[0];
            }
          };
        }
      },
      async getAlarm() { return alarm; },
      async setAlarm(scheduledTime) {
        alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
      },
      async deleteAlarm() { alarm = null; }
    },
    async blockConcurrencyWhile<T>(callback: () => Promise<T>) {
      return callback();
    },
    scheduledAlarm: () => alarm
  };
}

describeWithSqlite("SQLite-backed conversation Durable Object", () => {
  it("persists, deduplicates, paginates, and updates internal policy state", async () => {
    if (!sqliteModule) throw new Error("node:sqlite unavailable");
    const database = new sqliteModule.DatabaseSync(":memory:");
    const store = new ConversationObject(contextFor(database), {});
    await store.initializeTenant("tenant-1");

    const first = {
      providerAccountRef: "provider-account",
      providerParticipantRef: "provider-participant",
      conversationRef: "conv-1",
      messageRef: "message-1",
      direction: "inbound" as const,
      kind: "text" as const,
      text: "First message",
      occurredAt: "2026-09-05T10:00:00.000Z",
      status: "received" as const
    };
    await store.ingestMessage(first);
    await store.ingestMessage(first);
    await store.ingestMessage({
      ...first,
      messageRef: "message-2",
      text: "Second message",
      occurredAt: "2026-09-05T11:00:00.000Z"
    });
    await store.updatePolicyState({
      conversationRef: "conv-1",
      recipientOptedOut: true,
      automationPaused: true,
      policyRevision: "v2"
    });

    const list = await store.listConversations({ limit: 1 });
    expect(list.conversations[0]).toMatchObject({
      conversationRef: "conv-1",
      messageCount: 2,
      unreadInboundCount: 2,
      recipientOptedOut: true,
      automationPaused: true,
      policyRevision: "v2"
    });
    await store.markConversationRead("conv-1", "2026-09-05T11:30:00.000Z");
    expect((await store.listConversations({ limit: 1 })).conversations[0].unreadInboundCount)
      .toBe(0);
    expect(await store.getConversationEnforcementState("conv-1")).toMatchObject({
      providerAccountRef: "provider-account",
      providerParticipantRef: "provider-participant",
      lastVerifiedUserInboundAt: "2026-09-05T11:00:00.000Z",
      recipientOptedOut: true,
      automationPaused: true,
      policyRevision: "v2"
    });
    const firstPage = await store.getConversationHistory({
      conversationRef: "conv-1",
      limit: 1
    });
    expect(firstPage?.messages[0].messageRef).toBe("message-2");
    expect(firstPage?.nextCursor).toBeDefined();
    const secondPage = await store.getConversationHistory({
      conversationRef: "conv-1",
      limit: 1,
      cursor: firstPage?.nextCursor
    });
    expect(secondPage?.messages[0].messageRef).toBe("message-1");
    database.close();
  });

  it("reconciles a delivery status that arrives before its message record", async () => {
    if (!sqliteModule) throw new Error("node:sqlite unavailable");
    const database = new sqliteModule.DatabaseSync(":memory:");
    const store = new ConversationObject(contextFor(database), {});
    await store.initializeTenant("tenant-1");
    await store.updateMessageStatus({
      messageRef: "message-outbound",
      status: "delivered",
      occurredAt: "2026-09-05T10:01:00.000Z"
    });
    await store.ingestMessage({
      providerAccountRef: "provider-account",
      providerParticipantRef: "provider-participant",
      conversationRef: "conv-1",
      messageRef: "message-outbound",
      direction: "outbound",
      kind: "text",
      text: "Order update",
      occurredAt: "2026-09-05T10:00:00.000Z",
      status: "accepted"
    });

    const history = await store.getConversationHistory({ conversationRef: "conv-1" });
    expect(history?.messages[0].status).toBe("delivered");
    database.close();
  });

  it("binds each Durable Object instance to one immutable tenant identity", async () => {
    if (!sqliteModule) throw new Error("node:sqlite unavailable");
    const database = new sqliteModule.DatabaseSync(":memory:");
    const store = new ConversationObject(contextFor(database), {});
    await store.initializeTenant("tenant-1");
    await expect(store.initializeTenant("tenant-2")).rejects.toThrow("Tenant identity mismatch");
    database.close();
  });

  it("applies bounded retention at exact cutoffs and reschedules the tenant alarm", async () => {
    if (!sqliteModule) throw new Error("node:sqlite unavailable");
    const database = new sqliteModule.DatabaseSync(":memory:");
    const context = contextFor(database);
    const store = new ConversationObject(context, {});
    await store.initializeTenant("tenant-retention");
    await store.configureRetention({
      messageRetentionDays: 90,
      inactiveConversationRetentionDays: 365,
      pendingStatusRetentionDays: 7,
      pruneIntervalHours: 24
    }, "2026-09-05T12:00:00.000Z");
    expect(context.scheduledAlarm()).toBe(Date.parse("2026-09-06T12:00:00.000Z"));

    const base = {
      providerAccountRef: "provider-account",
      providerParticipantRef: "provider-participant",
      direction: "inbound" as const,
      kind: "text" as const,
      status: "received" as const
    };
    await store.ingestMessage({
      ...base,
      conversationRef: "conv-expired",
      messageRef: "message-expired",
      text: "Expired",
      occurredAt: "2025-08-01T00:00:00.000Z"
    });
    await store.ingestMessage({
      ...base,
      conversationRef: "conv-active",
      messageRef: "message-at-cutoff",
      text: "Boundary",
      occurredAt: "2026-06-07T12:00:00.000Z"
    });
    await store.ingestMessage({
      ...base,
      conversationRef: "conv-opted-out",
      messageRef: "message-opted-out",
      text: "Remove body but retain suppression",
      occurredAt: "2025-08-01T00:00:00.000Z"
    });
    await store.updatePolicyState({
      conversationRef: "conv-opted-out",
      recipientOptedOut: true,
      policyRevision: "opt-out-v1"
    });
    await store.updateMessageStatus({
      messageRef: "orphan-expired",
      status: "delivered",
      occurredAt: "2026-08-01T00:00:00.000Z"
    });

    const result = await store.runRetention("2026-09-05T12:00:00.000Z");
    expect(result).toMatchObject({
      messageCutoff: "2026-06-07T12:00:00.000Z",
      inactiveConversationCutoff: "2025-09-05T12:00:00.000Z",
      pendingStatusCutoff: "2026-08-29T12:00:00.000Z",
      messagesDeleted: 2,
      conversationsDeleted: 1,
      pendingStatusesDeleted: 1,
      nextRunAt: "2026-09-06T12:00:00.000Z"
    });
    expect(await store.getConversationHistory({ conversationRef: "conv-expired" })).toBeNull();
    expect((await store.getConversationHistory({ conversationRef: "conv-active" }))?.messages)
      .toHaveLength(1);
    expect(await store.getConversationEnforcementState("conv-opted-out")).toMatchObject({
      recipientOptedOut: true,
      policyRevision: "opt-out-v1"
    });
    expect((await store.getConversationHistory({ conversationRef: "conv-opted-out" }))?.messages)
      .toHaveLength(0);
    expect(context.scheduledAlarm()).toBe(Date.parse("2026-09-06T12:00:00.000Z"));
    database.close();
  });

  it("supports authenticated internal deletion without exposing an MCP mutation", async () => {
    if (!sqliteModule) throw new Error("node:sqlite unavailable");
    const database = new sqliteModule.DatabaseSync(":memory:");
    const store = new ConversationObject(contextFor(database), {});
    await store.initializeTenant("tenant-delete");
    const message = {
      providerAccountRef: "provider-account",
      providerParticipantRef: "provider-participant",
      conversationRef: "conv-delete",
      messageRef: "message-delete",
      direction: "inbound" as const,
      kind: "text" as const,
      text: "Delete me",
      occurredAt: "2026-09-05T10:00:00.000Z",
      status: "received" as const
    };
    await store.ingestMessage(message);
    await store.ingestMessage({
      ...message,
      conversationRef: "conv-keep-until-full-delete",
      messageRef: "message-keep"
    });

    await expect(store.deleteConversationData(""))
      .rejects.toThrow("Invalid conversation reference");
    expect(await store.deleteConversationData("conv-delete")).toEqual({
      conversationsDeleted: 1,
      messagesDeleted: 1,
      pendingStatusesDeleted: 0
    });
    expect(await store.getConversationHistory({ conversationRef: "conv-delete" })).toBeNull();
    expect(await store.deleteAllConversationData()).toEqual({
      conversationsDeleted: 1,
      messagesDeleted: 1,
      pendingStatusesDeleted: 0
    });
    expect((await store.listConversations({})).conversations).toEqual([]);
    await expect(store.initializeTenant("another-tenant"))
      .rejects.toThrow("Tenant identity mismatch");
    database.close();
  });

  it("rejects unsafe retention configurations and does not replace an existing alarm", async () => {
    if (!sqliteModule) throw new Error("node:sqlite unavailable");
    const database = new sqliteModule.DatabaseSync(":memory:");
    const context = contextFor(database);
    const store = new ConversationObject(context, {});
    await store.initializeTenant("tenant-policy");
    await expect(store.configureRetention({
      messageRetentionDays: 0,
      inactiveConversationRetentionDays: 365,
      pendingStatusRetentionDays: 7,
      pruneIntervalHours: 24
    }, "2026-09-05T12:00:00.000Z")).rejects.toThrow("Message retention");
    await store.configureRetention({
      messageRetentionDays: 90,
      inactiveConversationRetentionDays: 365,
      pendingStatusRetentionDays: 7,
      pruneIntervalHours: 24
    }, "2026-09-05T12:00:00.000Z");
    const firstAlarm = context.scheduledAlarm();
    await store.configureRetention({
      messageRetentionDays: 30,
      inactiveConversationRetentionDays: 365,
      pendingStatusRetentionDays: 7,
      pruneIntervalHours: 12
    }, "2026-09-05T13:00:00.000Z");
    expect(context.scheduledAlarm()).toBe(firstAlarm);
    database.close();
  });

  it("loads safe retention defaults and validates Worker overrides", () => {
    expect(retentionPolicyFromEnv({})).toEqual({
      messageRetentionDays: 90,
      inactiveConversationRetentionDays: 365,
      pendingStatusRetentionDays: 7,
      pruneIntervalHours: 24
    });
    expect(retentionPolicyFromEnv({
      CONVERSATION_MESSAGE_RETENTION_DAYS: "30",
      CONVERSATION_INACTIVE_RETENTION_DAYS: "180",
      CONVERSATION_PENDING_STATUS_RETENTION_DAYS: "3",
      CONVERSATION_RETENTION_INTERVAL_HOURS: "12"
    })).toEqual({
      messageRetentionDays: 30,
      inactiveConversationRetentionDays: 180,
      pendingStatusRetentionDays: 3,
      pruneIntervalHours: 12
    });
    expect(() => retentionPolicyFromEnv({
      CONVERSATION_MESSAGE_RETENTION_DAYS: "forever"
    })).toThrow("CONVERSATION_MESSAGE_RETENTION_DAYS must be an integer");
    expect(() => retentionPolicyFromEnv({
      CONVERSATION_MESSAGE_RETENTION_DAYS: "90",
      CONVERSATION_INACTIVE_RETENTION_DAYS: "30"
    })).toThrow("Inactive conversation retention");
  });

  it("rejects non-canonical timestamps so lexical retention cutoffs stay correct", async () => {
    if (!sqliteModule) throw new Error("node:sqlite unavailable");
    const database = new sqliteModule.DatabaseSync(":memory:");
    const store = new ConversationObject(contextFor(database), {});
    await store.initializeTenant("tenant-timestamps");
    await expect(store.ingestMessage({
      providerAccountRef: "provider-account",
      providerParticipantRef: "provider-participant",
      conversationRef: "conv-1",
      messageRef: "message-1",
      direction: "inbound",
      kind: "text",
      occurredAt: "2026-09-05T07:00:00-05:00",
      status: "received"
    })).rejects.toThrow("Invalid message timestamp");
    await expect(store.runRetention("2026-09-05T07:00:00-05:00"))
      .rejects.toThrow("Invalid retention run time");
    database.close();
  });
});
