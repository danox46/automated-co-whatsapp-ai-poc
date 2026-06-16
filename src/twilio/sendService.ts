export type TwilioOutboundMessage = {
  to: string;
  body: string;
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

  const form = new URLSearchParams({
    To: message.to,
    From: from,
    Body: message.body
  });

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    }
  );

  const payload = (await response.json()) as {
    sid?: string;
    status?: string;
    direction?: string;
    message?: string;
  };

  if (!response.ok) {
    throw new Error(`Twilio send failed: ${payload.message ?? response.statusText}`);
  }

  return {
    sid: payload.sid ?? "",
    status: payload.status ?? "unknown",
    direction: payload.direction ?? "unknown"
  };
}
