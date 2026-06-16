export type InboundMessage = {
  provider: "twilio_whatsapp";
  providerMessageId?: string;
  from?: string;
  to?: string;
  body: string;
  receivedAt: string;
  raw: unknown;
};
