import twilio from "twilio";

export type TwilioOutboundMessage = {
  to: string;
  body: string;
  statusCallback?: string;
};

export type TwilioSendResult = {
  sid: string;
  status: string;
  direction: string;
};

export type TwilioSendConfig = {
  accountSid?: string;
  authToken?: string;
  whatsappFrom?: string;
};

export async function sendWhatsappMessage(
  config: TwilioSendConfig,
  message: TwilioOutboundMessage
): Promise<TwilioSendResult> {
  const accountSid = config.accountSid;
  const authToken = config.authToken;
  const from = config.whatsappFrom;

  if (!accountSid || !authToken || !from) {
    throw new Error("Missing Twilio configuration. Check TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_FROM.");
  }

  const client = twilio(accountSid, authToken);
  const payload = await client.messages.create({
    to: message.to,
    from,
    body: message.body,
    statusCallback: message.statusCallback
  });

  return {
    sid: payload.sid,
    status: payload.status,
    direction: payload.direction
  };
}
