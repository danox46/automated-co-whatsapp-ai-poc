import type { InboundMessage } from "./types.js";

type TwilioWebhookBody = {
  MessageSid?: string;
  SmsMessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
};

export function normalizeInboundMessage(rawBody: TwilioWebhookBody): InboundMessage {
  return {
    provider: "twilio_whatsapp",
    providerMessageId: rawBody.MessageSid ?? rawBody.SmsMessageSid,
    from: rawBody.From,
    to: rawBody.To,
    body: rawBody.Body ?? "",
    receivedAt: new Date().toISOString(),
    raw: rawBody
  };
}
