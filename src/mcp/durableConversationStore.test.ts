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
const sqliteModule = await import("node:sqlite").catch(() => null);
const describeWithSqlite = sqliteModule ? describe : describe.skip;

beforeAll(async () => {
  ({ WhatsAppConversationDurableObject: ConversationObject } = await import("./durableConversationStore.js"));
});

function contextFor(database: DatabaseSyncType): DurableObjectState {
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
      }
    },
    async blockConcurrencyWhile<T>(callback: () => Promise<T>) {
      return callback();
    }
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
});
