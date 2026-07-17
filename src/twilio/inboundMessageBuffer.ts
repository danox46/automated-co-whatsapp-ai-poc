import type { InboundMessage } from "../messages/types.js";

export type BufferedInboundBatch = {
  key: string;
  messages: InboundMessage[];
  combinedMessage: InboundMessage;
};

type PendingBatch = {
  messages: InboundMessage[];
  timer: ReturnType<typeof setTimeout>;
};

export class InboundMessageBuffer {
  private readonly pending = new Map<string, PendingBatch>();

  constructor(
    private readonly options: {
      idleMs: number;
      onFlush: (batch: BufferedInboundBatch) => void | Promise<void>;
    }
  ) {}

  enqueue(message: InboundMessage) {
    const key = participantKeyForBuffer(message);
    const existing = this.pending.get(key);

    if (existing) {
      existing.messages.push(message);
      clearTimeout(existing.timer);
      existing.timer = this.scheduleFlush(key);
      return existing.messages.length;
    }

    this.pending.set(key, {
      messages: [message],
      timer: this.scheduleFlush(key)
    });

    return 1;
  }

  flushNow(key: string) {
    const batch = this.pending.get(key);
    if (!batch) {
      return;
    }

    clearTimeout(batch.timer);
    this.pending.delete(key);
    void this.options.onFlush({
      key,
      messages: batch.messages,
      combinedMessage: combineInboundMessages(batch.messages)
    });
  }

  private scheduleFlush(key: string) {
    return setTimeout(() => {
      this.flushNow(key);
    }, this.options.idleMs);
  }
}

export function combineInboundMessages(messages: InboundMessage[]): InboundMessage {
  const [first] = messages;
  if (!first) {
    throw new Error("Cannot combine an empty inbound message batch.");
  }

  return {
    ...first,
    providerMessageId: messages
      .map((message) => message.providerMessageId)
      .filter(Boolean)
      .join("+"),
    body: messages.map((message) => message.body).join("\n"),
    receivedAt: messages[0].receivedAt,
    raw: {
      batchedMessages: messages.map((message) => ({
        providerMessageId: message.providerMessageId,
        from: message.from,
        to: message.to,
        body: message.body,
        receivedAt: message.receivedAt
      }))
    }
  };
}

export function participantKeyForBuffer(message: InboundMessage) {
  return message.from ?? `message:${message.providerMessageId ?? "unknown"}`;
}
