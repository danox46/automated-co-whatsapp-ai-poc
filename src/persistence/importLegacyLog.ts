import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { InboundMessage } from "../messages/types.js";
import type { OperatorRepository } from "./operatorRepository.js";

type LegacyEvent = {
  status?: string;
  inbound?: {
    providerMessageId?: string;
    from?: string;
    to?: string;
    body?: string;
    receivedAt?: string;
  };
  result?: {
    shouldSend?: boolean;
    responseText?: string;
    sendResult?: { sid?: string; status?: string };
  };
};

export async function importLegacyWebhookLogOnce(repository: OperatorRepository, filePath: string) {
  const absolutePath = resolve(filePath);
  const marker = `legacy-jsonl-import:${absolutePath}`;
  if (repository.getMeta(marker)) return { imported: 0, skipped: true };

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { imported: 0, skipped: false };
    throw error;
  }

  let imported = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: LegacyEvent;
    try {
      event = JSON.parse(line) as LegacyEvent;
    } catch {
      continue;
    }
    if (!event.inbound?.providerMessageId || !event.inbound.from) continue;
    const message: InboundMessage = {
      provider: "twilio_whatsapp",
      providerMessageId: event.inbound.providerMessageId,
      from: event.inbound.from,
      to: event.inbound.to,
      body: event.inbound.body ?? "",
      media: [],
      receivedAt: event.inbound.receivedAt ?? new Date().toISOString(),
      raw: { importedFromLegacyJsonl: true }
    };
    const result = repository.ingestInbound(message);
    if (!result.created) continue;
    imported += 1;
    if (event.result?.shouldSend && event.result.responseText) {
      const outbound = repository.createOutboundMessage({
        conversationId: result.conversationId,
        body: event.result.responseText,
        author: "bot"
      });
      if (event.result.sendResult?.sid) {
        repository.attachProviderResult(
          outbound.messageId,
          event.result.sendResult.sid,
          event.result.sendResult.status ?? "sent"
        );
      }
    }
  }

  repository.setMeta(marker, JSON.stringify({ imported, importedAt: new Date().toISOString() }));
  repository.recordAudit("legacy_jsonl_imported", { path: absolutePath, imported });
  return { imported, skipped: false };
}
