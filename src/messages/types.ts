export type InboundMessage = {
  provider: "twilio_whatsapp";
  providerMessageId?: string;
  from?: string;
  to?: string;
  body: string;
  waId?: string;
  profileName?: string;
  media?: InboundMediaReference[];
  receivedAt: string;
  raw: unknown;
};

export type InboundMediaReference = {
  index: number;
  url: string;
  contentType: string;
};
