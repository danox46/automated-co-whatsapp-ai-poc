import type { DeliveryGuidance } from "../delivery/deliveryGuidance.js";
import type { ExtractedFields } from "../messages/extractFields.js";
import type { InboundMessage } from "../messages/types.js";
import type { Intent } from "../intents/classifier.js";

export type ConversationTurn = {
  direction: "inbound" | "outbound";
  body: string;
  at: string;
  intent?: Intent;
  resolvedIntent?: Intent;
  extracted?: ExtractedFields;
  deliveryGuidance?: DeliveryGuidance;
};

export type ConversationContext = {
  sessionId: string;
  participantKey: string;
  startedAt: string;
  lastSeenAt: string;
  windowHours: number;
  automationDisclosureSent: boolean;
  turns: ConversationTurn[];
};

export type ConversationTurnResult = {
  inbound: ConversationTurn;
  outbound?: ConversationTurn;
  automationDisclosureSent?: boolean;
};

type SessionRecord = Omit<ConversationContext, "turns"> & {
  turns: ConversationTurn[];
};

export class InMemoryConversationSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly options: {
      windowMs?: number;
      maxTurns?: number;
      now?: () => Date;
    } = {}
  ) {}

  getContext(message: InboundMessage): ConversationContext {
    const now = this.now();
    const participantKey = participantKeyFor(message);
    const existing = this.sessions.get(participantKey);

    if (existing && now.getTime() - Date.parse(existing.lastSeenAt) <= this.windowMs) {
      existing.lastSeenAt = now.toISOString();
      return cloneContext(existing, this.windowHours);
    }

    const session: SessionRecord = {
      sessionId: createSessionId(participantKey, now),
      participantKey,
      startedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      windowHours: this.windowHours,
      automationDisclosureSent: false,
      turns: []
    };

    this.sessions.set(participantKey, session);
    return cloneContext(session, this.windowHours);
  }

  recordTurn(participantKey: string, result: ConversationTurnResult) {
    const now = this.now();
    const session = this.sessions.get(participantKey);
    if (!session) {
      return;
    }

    session.lastSeenAt = now.toISOString();
    session.turns.push(result.inbound);
    if (result.outbound) {
      session.turns.push(result.outbound);
    }

    if (typeof result.automationDisclosureSent === "boolean") {
      session.automationDisclosureSent = result.automationDisclosureSent;
    }

    session.turns = session.turns.slice(-this.maxTurns);
  }

  clearExpired() {
    const nowMs = this.now().getTime();

    for (const [key, session] of this.sessions.entries()) {
      if (nowMs - Date.parse(session.lastSeenAt) > this.windowMs) {
        this.sessions.delete(key);
      }
    }
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  private get windowMs() {
    return this.options.windowMs ?? 24 * 60 * 60 * 1000;
  }

  private get windowHours() {
    return this.windowMs / (60 * 60 * 1000);
  }

  private get maxTurns() {
    return this.options.maxTurns ?? 20;
  }
}

export function participantKeyFor(message: InboundMessage) {
  return message.from ?? `message:${message.providerMessageId ?? "unknown"}`;
}

function cloneContext(session: SessionRecord, windowHours: number): ConversationContext {
  return {
    sessionId: session.sessionId,
    participantKey: session.participantKey,
    startedAt: session.startedAt,
    lastSeenAt: session.lastSeenAt,
    windowHours,
    automationDisclosureSent: session.automationDisclosureSent,
    turns: session.turns.map((turn) => ({ ...turn }))
  };
}

function createSessionId(participantKey: string, date: Date) {
  const safeKey = participantKey.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${safeKey}_${date.getTime()}`;
}
