import { describe, expect, it } from "vitest";
import { InMemoryConversationSessionStore } from "./conversationSessionStore.js";
import type { InboundMessage } from "../messages/types.js";

describe("InMemoryConversationSessionStore", () => {
  it("keeps the same session for the same sender inside the 24 hour window", () => {
    let now = new Date("2026-06-16T10:00:00.000Z");
    const store = new InMemoryConversationSessionStore({ now: () => now });

    const first = store.getContext(message("whatsapp:+573001112233"));
    now = new Date("2026-06-17T09:59:00.000Z");
    const second = store.getContext(message("whatsapp:+573001112233"));

    expect(second.sessionId).toBe(first.sessionId);
  });

  it("starts a new session for the same sender after the 24 hour window", () => {
    let now = new Date("2026-06-16T10:00:00.000Z");
    const store = new InMemoryConversationSessionStore({ now: () => now });

    const first = store.getContext(message("whatsapp:+573001112233"));
    now = new Date("2026-06-17T10:01:00.000Z");
    const second = store.getContext(message("whatsapp:+573001112233"));

    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("stores bounded recent turns", () => {
    const store = new InMemoryConversationSessionStore({ maxTurns: 2 });
    const context = store.getContext(message("whatsapp:+573001112233"));

    store.recordTurn(context.participantKey, {
      inbound: { direction: "inbound", body: "one", at: "2026-06-16T10:00:00.000Z" },
      outbound: { direction: "outbound", body: "two", at: "2026-06-16T10:00:01.000Z" }
    });
    store.recordTurn(context.participantKey, {
      inbound: { direction: "inbound", body: "three", at: "2026-06-16T10:00:02.000Z" }
    });

    expect(store.getContext(message("whatsapp:+573001112233")).turns.map((turn) => turn.body)).toEqual([
      "two",
      "three"
    ]);
  });
});

function message(from: string): InboundMessage {
  return {
    provider: "twilio_whatsapp",
    providerMessageId: "SM_TEST",
    from,
    to: "whatsapp:+14155238886",
    body: "Hola",
    receivedAt: new Date().toISOString(),
    raw: {}
  };
}
