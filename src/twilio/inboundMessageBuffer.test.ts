import { describe, expect, it, vi } from "vitest";
import { combineInboundMessages, InboundMessageBuffer } from "./inboundMessageBuffer.js";
import type { InboundMessage } from "../messages/types.js";

describe("InboundMessageBuffer", () => {
  it("combines messages from the same sender after the idle window", () => {
    vi.useFakeTimers();
    const flushed: string[] = [];
    const buffer = new InboundMessageBuffer({
      idleMs: 5000,
      onFlush: (batch) => flushed.push(batch.combinedMessage.body)
    });

    buffer.enqueue(message("SM1", "Primera parte"));
    vi.advanceTimersByTime(3000);
    buffer.enqueue(message("SM2", "segunda parte"));
    vi.advanceTimersByTime(4999);

    expect(flushed).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(flushed).toEqual(["Primera parte\nsegunda parte"]);

    vi.useRealTimers();
  });

  it("combines provider ids for trace reconstruction", () => {
    const combined = combineInboundMessages([
      message("SM1", "Córdoba"),
      message("SM2", "Planeta Rica")
    ]);

    expect(combined.providerMessageId).toBe("SM1+SM2");
    expect(combined.body).toBe("Córdoba\nPlaneta Rica");
    expect(combined.raw).toMatchObject({
      batchedMessages: [
        { providerMessageId: "SM1", body: "Córdoba" },
        { providerMessageId: "SM2", body: "Planeta Rica" }
      ]
    });
  });
});

function message(providerMessageId: string, body: string): InboundMessage {
  return {
    provider: "twilio_whatsapp",
    providerMessageId,
    from: "whatsapp:+573001112233",
    to: "whatsapp:+14155238886",
    body,
    receivedAt: "2026-06-16T10:00:00.000Z",
    raw: {}
  };
}
