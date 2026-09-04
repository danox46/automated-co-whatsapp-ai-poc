import type { InboundMessage } from "./types.js";

type TwilioWebhookBody = {
  MessageSid?: string;
  SmsMessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
  ProfileName?: string;
  WaId?: string;
  NumMedia?: string;
  [key: `MediaUrl${number}`]: string | undefined;
  [key: `MediaContentType${number}`]: string | undefined;
};

export function normalizeInboundMessage(rawBody: TwilioWebhookBody): InboundMessage {
  const mediaCount = Math.max(0, Number.parseInt(rawBody.NumMedia ?? "0", 10) || 0);
  const media = Array.from({ length: mediaCount }, (_, index) => ({
    index,
    url: rawBody[`MediaUrl${index}`] ?? "",
    contentType: rawBody[`MediaContentType${index}`] ?? "application/octet-stream"
  })).filter((item) => item.url.length > 0);

  return {
    provider: "twilio_whatsapp",
    providerMessageId: rawBody.MessageSid ?? rawBody.SmsMessageSid,
    from: rawBody.From,
    to: rawBody.To,
    body: rawBody.Body ?? "",
    waId: cleanOptional(rawBody.WaId),
    profileName: cleanOptional(rawBody.ProfileName),
    media,
    receivedAt: new Date().toISOString(),
    raw: rawBody
  };
}

function cleanOptional(value?: string) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}
