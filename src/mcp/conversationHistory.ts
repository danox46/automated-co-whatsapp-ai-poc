import type { WhatsAppMcpPrincipal } from "./auth.js";

export const DEFAULT_CONVERSATION_PAGE_SIZE = 20;
export const MAX_CONVERSATION_PAGE_SIZE = 50;
export const DEFAULT_MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_PAGE_SIZE = 100;

export type WhatsAppMessageDirection = "inbound" | "outbound";
export type WhatsAppMessageKind =
  | "text"
  | "template"
  | "interactive"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "location"
  | "contact"
  | "sticker"
  | "reaction"
  | "unknown";
export type WhatsAppMessageStatus =
  | "received"
  | "accepted"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export type ConversationPolicyState = {
  recipientOptedOut: boolean;
  automationPaused: boolean;
  policyRevision: string;
};

export type StoredConversation = ConversationPolicyState & {
  conversationRef: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  lastVerifiedUserInboundAt?: string;
  lastOutboundAt?: string;
  messageCount: number;
  unreadInboundCount: number;
};

export type StoredConversationMessage = {
  messageRef: string;
  conversationRef: string;
  direction: WhatsAppMessageDirection;
  kind: WhatsAppMessageKind;
  text?: string;
  templateName?: string;
  occurredAt: string;
  status: WhatsAppMessageStatus;
};

export type ConversationSummary = StoredConversation & {
  customerServiceWindow: {
    status: "open" | "closed" | "unavailable";
    closesAt?: string;
  };
};

export type ConversationListQuery = {
  limit?: number;
  cursor?: string;
  updatedAfter?: string;
};

export type ConversationHistoryQuery = {
  conversationRef: string;
  limit?: number;
  cursor?: string;
};

export type ConversationListResult = {
  conversations: ConversationSummary[];
  nextCursor?: string;
};

export type ConversationHistoryResult = {
  conversation: ConversationSummary;
  messages: StoredConversationMessage[];
  nextCursor?: string;
};

export type InternalConversationMessage = StoredConversationMessage & {
  tenantId: string;
  providerAccountRef: string;
  providerParticipantRef: string;
  displayName?: string;
};

export type InternalMessageStatusUpdate = {
  tenantId: string;
  messageRef: string;
  status: WhatsAppMessageStatus;
  occurredAt: string;
};

export type InternalConversationPolicyPatch = {
  tenantId: string;
  conversationRef: string;
  recipientOptedOut?: boolean;
  automationPaused?: boolean;
  policyRevision: string;
};

export type InternalConversationEnforcementState = ConversationPolicyState & {
  conversationRef: string;
  providerAccountRef: string;
  providerParticipantRef: string;
  lastVerifiedUserInboundAt?: string;
  lastOutboundAt?: string;
};

export interface WhatsAppConversationReader {
  listConversations(
    principal: WhatsAppMcpPrincipal,
    query: ConversationListQuery
  ): Promise<ConversationListResult>;
  getConversationHistory(
    principal: WhatsAppMcpPrincipal,
    query: ConversationHistoryQuery
  ): Promise<ConversationHistoryResult | null>;
}

export interface WhatsAppConversationWriter {
  ingestMessage(message: InternalConversationMessage): Promise<void>;
  updateMessageStatus(update: InternalMessageStatusUpdate): Promise<void>;
  updatePolicyState(patch: InternalConversationPolicyPatch): Promise<void>;
  markConversationRead(tenantId: string, conversationRef: string, readAt: string): Promise<void>;
  pruneMessages(tenantId: string, occurredBefore: string): Promise<number>;
}

export interface WhatsAppConversationEnforcementReader {
  getConversationEnforcementState(
    tenantId: string,
    conversationRef: string
  ): Promise<InternalConversationEnforcementState | null>;
}

type TenantState = {
  conversations: Map<string, StoredConversation & {
    providerAccountRef: string;
    providerParticipantRef: string;
  }>;
  messages: Map<string, StoredConversationMessage>;
  pendingStatuses: Map<string, WhatsAppMessageStatus>;
};

export class InMemoryWhatsAppConversationStore
implements WhatsAppConversationReader, WhatsAppConversationWriter, WhatsAppConversationEnforcementReader {
  private readonly tenants = new Map<string, TenantState>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async ingestMessage(message: InternalConversationMessage): Promise<void> {
    assertIsoDate(message.occurredAt, "occurredAt");
    const tenant = this.tenant(message.tenantId);
    if (tenant.messages.has(message.messageRef)) return;

    const existing = tenant.conversations.get(message.conversationRef);
    const isInbound = message.direction === "inbound";
    const conversation = existing ?? {
      conversationRef: message.conversationRef,
      providerAccountRef: message.providerAccountRef,
      providerParticipantRef: message.providerParticipantRef,
      createdAt: message.occurredAt,
      updatedAt: message.occurredAt,
      lastMessageAt: message.occurredAt,
      messageCount: 0,
      unreadInboundCount: 0,
      recipientOptedOut: false,
      automationPaused: false,
      policyRevision: "v1"
    };

    conversation.displayName = message.displayName ?? conversation.displayName;
    conversation.updatedAt = maxIso(conversation.updatedAt, message.occurredAt);
    conversation.lastMessageAt = maxIso(conversation.lastMessageAt, message.occurredAt);
    conversation.messageCount += 1;
    if (isInbound) {
      conversation.lastVerifiedUserInboundAt = maxOptionalIso(
        conversation.lastVerifiedUserInboundAt,
        message.occurredAt
      );
      conversation.unreadInboundCount += 1;
    } else {
      conversation.lastOutboundAt = maxOptionalIso(conversation.lastOutboundAt, message.occurredAt);
    }

    tenant.conversations.set(message.conversationRef, conversation);
    const storedMessage: StoredConversationMessage = {
      messageRef: message.messageRef,
      conversationRef: message.conversationRef,
      direction: message.direction,
      kind: message.kind,
      ...(message.text ? { text: message.text } : {}),
      ...(message.templateName ? { templateName: message.templateName } : {}),
      occurredAt: message.occurredAt,
      status: message.status
    };
    const pendingStatus = tenant.pendingStatuses.get(message.messageRef);
    if (pendingStatus) {
      storedMessage.status = laterStatus(storedMessage.status, pendingStatus);
      tenant.pendingStatuses.delete(message.messageRef);
    }
    tenant.messages.set(message.messageRef, storedMessage);
  }

  async updateMessageStatus(update: InternalMessageStatusUpdate): Promise<void> {
    assertIsoDate(update.occurredAt, "occurredAt");
    const message = this.tenant(update.tenantId).messages.get(update.messageRef);
    if (!message) {
      const tenant = this.tenant(update.tenantId);
      const pending = tenant.pendingStatuses.get(update.messageRef);
      tenant.pendingStatuses.set(
        update.messageRef,
        pending ? laterStatus(pending, update.status) : update.status
      );
      return;
    }
    message.status = laterStatus(message.status, update.status);
  }

  async updatePolicyState(patch: InternalConversationPolicyPatch): Promise<void> {
    const conversation = this.tenant(patch.tenantId).conversations.get(patch.conversationRef);
    if (!conversation) return;
    if (typeof patch.recipientOptedOut === "boolean") {
      conversation.recipientOptedOut = patch.recipientOptedOut;
    }
    if (typeof patch.automationPaused === "boolean") {
      conversation.automationPaused = patch.automationPaused;
    }
    conversation.policyRevision = patch.policyRevision;
    conversation.updatedAt = this.now().toISOString();
  }

  async markConversationRead(
    tenantId: string,
    conversationRef: string,
    readAt: string
  ): Promise<void> {
    assertIsoDate(readAt, "readAt");
    const conversation = this.tenant(tenantId).conversations.get(conversationRef);
    if (!conversation) return;
    conversation.unreadInboundCount = 0;
    conversation.updatedAt = maxIso(conversation.updatedAt, readAt);
  }

  async getConversationEnforcementState(
    tenantId: string,
    conversationRef: string
  ): Promise<InternalConversationEnforcementState | null> {
    const conversation = this.tenant(tenantId).conversations.get(conversationRef);
    if (!conversation) return null;
    return {
      conversationRef,
      providerAccountRef: conversation.providerAccountRef,
      providerParticipantRef: conversation.providerParticipantRef,
      ...(conversation.lastVerifiedUserInboundAt
        ? { lastVerifiedUserInboundAt: conversation.lastVerifiedUserInboundAt }
        : {}),
      ...(conversation.lastOutboundAt ? { lastOutboundAt: conversation.lastOutboundAt } : {}),
      recipientOptedOut: conversation.recipientOptedOut,
      automationPaused: conversation.automationPaused,
      policyRevision: conversation.policyRevision
    };
  }

  async pruneMessages(tenantId: string, occurredBefore: string): Promise<number> {
    assertIsoDate(occurredBefore, "occurredBefore");
    const tenant = this.tenant(tenantId);
    let removed = 0;
    for (const [messageRef, message] of tenant.messages) {
      if (message.occurredAt < occurredBefore) {
        tenant.messages.delete(messageRef);
        removed += 1;
      }
    }
    for (const conversation of tenant.conversations.values()) {
      const retained = [...tenant.messages.values()]
        .filter((message) => message.conversationRef === conversation.conversationRef);
      conversation.messageCount = retained.length;
      conversation.unreadInboundCount = retained.filter(
        (message) => message.direction === "inbound" && message.status === "received"
      ).length;
    }
    return removed;
  }

  async listConversations(
    principal: WhatsAppMcpPrincipal,
    query: ConversationListQuery
  ): Promise<ConversationListResult> {
    const limit = boundedLimit(query.limit, DEFAULT_CONVERSATION_PAGE_SIZE, MAX_CONVERSATION_PAGE_SIZE);
    const cursor = decodeCursor(query.cursor);
    const updatedAfter = query.updatedAfter;
    if (updatedAfter) assertIsoDate(updatedAfter, "updatedAfter");

    const rows = [...this.tenant(principal.tenantId).conversations.values()]
      .filter((conversation) => !updatedAfter || conversation.updatedAt > updatedAfter)
      .filter((conversation) => !cursor || comparePageKey(conversation.updatedAt, conversation.conversationRef, cursor) < 0)
      .sort((left, right) => compareDescending(
        left.updatedAt,
        left.conversationRef,
        right.updatedAt,
        right.conversationRef
      ));
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page.at(-1) : undefined;

    return {
      conversations: page.map((conversation) => summarizeConversation(conversation, this.now())),
      ...(next ? { nextCursor: encodeCursor(next.updatedAt, next.conversationRef) } : {})
    };
  }

  async getConversationHistory(
    principal: WhatsAppMcpPrincipal,
    query: ConversationHistoryQuery
  ): Promise<ConversationHistoryResult | null> {
    const tenant = this.tenant(principal.tenantId);
    const conversation = tenant.conversations.get(query.conversationRef);
    if (!conversation) return null;
    const limit = boundedLimit(query.limit, DEFAULT_MESSAGE_PAGE_SIZE, MAX_MESSAGE_PAGE_SIZE);
    const cursor = decodeCursor(query.cursor);
    const rows = [...tenant.messages.values()]
      .filter((message) => message.conversationRef === query.conversationRef)
      .filter((message) => !cursor || comparePageKey(message.occurredAt, message.messageRef, cursor) < 0)
      .sort((left, right) => compareDescending(
        left.occurredAt,
        left.messageRef,
        right.occurredAt,
        right.messageRef
      ));
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page.at(-1) : undefined;

    return {
      conversation: summarizeConversation(conversation, this.now()),
      messages: page.map((message) => ({ ...message })),
      ...(next ? { nextCursor: encodeCursor(next.occurredAt, next.messageRef) } : {})
    };
  }

  private tenant(tenantId: string): TenantState {
    const existing = this.tenants.get(tenantId);
    if (existing) return existing;
    const created = {
      conversations: new Map(),
      messages: new Map(),
      pendingStatuses: new Map()
    };
    this.tenants.set(tenantId, created);
    return created;
  }
}

export function summarizeConversation(
  conversation: StoredConversation,
  now: Date
): ConversationSummary {
  const lastInbound = conversation.lastVerifiedUserInboundAt;
  const closesAt = lastInbound
    ? new Date(Date.parse(lastInbound) + 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  const status = !closesAt
    ? "unavailable" as const
    : now.getTime() < Date.parse(closesAt)
      ? "open" as const
      : "closed" as const;
  return {
    conversationRef: conversation.conversationRef,
    ...(conversation.displayName ? { displayName: conversation.displayName } : {}),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
    ...(lastInbound ? { lastVerifiedUserInboundAt: lastInbound } : {}),
    ...(conversation.lastOutboundAt ? { lastOutboundAt: conversation.lastOutboundAt } : {}),
    messageCount: conversation.messageCount,
    unreadInboundCount: conversation.unreadInboundCount,
    recipientOptedOut: conversation.recipientOptedOut,
    automationPaused: conversation.automationPaused,
    policyRevision: conversation.policyRevision,
    customerServiceWindow: {
      status,
      ...(closesAt ? { closesAt } : {})
    }
  };
}

export function encodeCursor(timestamp: string, reference: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([timestamp, reference]));
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeCursor(cursor?: string): { timestamp: string; reference: string } | null {
  if (!cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error("encoding");
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(value) || value.length !== 2) throw new Error("shape");
    const [timestamp, reference] = value;
    if (typeof timestamp !== "string" || typeof reference !== "string" || reference.length > 512) {
      throw new Error("types");
    }
    assertIsoDate(timestamp, "cursor timestamp");
    return { timestamp, reference };
  } catch {
    throw new Error("Invalid conversation cursor");
  }
}

export function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Limit must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function comparePageKey(
  timestamp: string,
  reference: string,
  cursor: { timestamp: string; reference: string }
): number {
  if (timestamp !== cursor.timestamp) return timestamp.localeCompare(cursor.timestamp);
  return reference.localeCompare(cursor.reference);
}

function compareDescending(
  leftTimestamp: string,
  leftReference: string,
  rightTimestamp: string,
  rightReference: string
): number {
  return rightTimestamp.localeCompare(leftTimestamp) || rightReference.localeCompare(leftReference);
}

function maxIso(left: string, right: string): string {
  return left >= right ? left : right;
}

function maxOptionalIso(left: string | undefined, right: string): string {
  return left ? maxIso(left, right) : right;
}

function assertIsoDate(value: string, field: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC ISO timestamp`);
  }
}

const statusOrder: Record<WhatsAppMessageStatus, number> = {
  received: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5
};

function laterStatus(
  current: WhatsAppMessageStatus,
  candidate: WhatsAppMessageStatus
): WhatsAppMessageStatus {
  return statusOrder[candidate] >= statusOrder[current] ? candidate : current;
}
