import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createWebhookEvent, WebhookEventLog } from "./webhookEventLog.js";
import type { InboundMessage } from "../messages/types.js";

describe("WebhookEventLog", () => {
  it("appends JSONL events for later session reconstruction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webhook-event-log-test-"));
    const logPath = join(dir, "events.jsonl");

    try {
      const log = new WebhookEventLog(logPath);
      await log.append(
        createWebhookEvent({
          status: "processed",
          inbound: message("Cuanto cuesta el domicilio?"),
          conversation: {
            sessionId: "session_1",
            participantKey: "whatsapp:+573001112233",
            startedAt: "2026-06-16T10:00:00.000Z",
            lastSeenAt: "2026-06-16T10:00:00.000Z",
            windowHours: 24,
            automationDisclosureSent: false,
            turns: []
          }
        })
      );

      const lines = (await readFile(logPath, "utf8")).trim().split("\n");
      const event = JSON.parse(lines[0]);

      expect(event).toMatchObject({
        eventType: "twilio_whatsapp_webhook",
        status: "processed",
        inbound: {
          from: "whatsapp:+573001112233",
          body: "Cuanto cuesta el domicilio?",
          messageCount: 1
        },
        session: {
          sessionId: "session_1",
          turnCount: 0
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function message(body: string): InboundMessage {
  return {
    provider: "twilio_whatsapp",
    providerMessageId: "SM_TEST",
    from: "whatsapp:+573001112233",
    to: "whatsapp:+14155238886",
    body,
    receivedAt: "2026-06-16T10:00:00.000Z",
    raw: {}
  };
}
