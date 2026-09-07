export type WhatsAppSandboxConfig = {
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  allowedRecipients: readonly string[];
  tokenExpiresAt?: string;
};

export type WhatsAppSandboxEnv = {
  META_SANDBOX_TENANT_ID?: string;
  META_SANDBOX_WABA_ID?: string;
  META_SANDBOX_PHONE_NUMBER_ID?: string;
  META_SANDBOX_ACCESS_TOKEN?: string;
  META_SANDBOX_ALLOWED_RECIPIENTS?: string;
  META_SANDBOX_TOKEN_EXPIRES_AT?: string;
};

export function readWhatsAppSandboxConfig(env: WhatsAppSandboxEnv): WhatsAppSandboxConfig | null {
  const values = [
    env.META_SANDBOX_TENANT_ID,
    env.META_SANDBOX_WABA_ID,
    env.META_SANDBOX_PHONE_NUMBER_ID,
    env.META_SANDBOX_ACCESS_TOKEN,
    env.META_SANDBOX_ALLOWED_RECIPIENTS
  ];
  if (values.every((value) => value === undefined || value === "")) return null;
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("The WhatsApp sandbox configuration is incomplete");
  }

  const tenantId = env.META_SANDBOX_TENANT_ID as string;
  const wabaId = env.META_SANDBOX_WABA_ID as string;
  const phoneNumberId = env.META_SANDBOX_PHONE_NUMBER_ID as string;
  const accessToken = env.META_SANDBOX_ACCESS_TOKEN as string;
  const allowedRecipients = [...new Set(
    (env.META_SANDBOX_ALLOWED_RECIPIENTS as string)
      .split(",")
      .map((value) => value.trim().replace(/^\+/u, ""))
      .filter(Boolean)
  )];

  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/u.test(tenantId)) throw new Error("Invalid sandbox tenant ID");
  if (!/^\d{3,32}$/u.test(wabaId)) throw new Error("Invalid sandbox WABA ID");
  if (!/^\d{3,32}$/u.test(phoneNumberId)) throw new Error("Invalid sandbox phone-number ID");
  if (accessToken.length < 20 || accessToken.length > 4096 || /\s/u.test(accessToken)) {
    throw new Error("Invalid sandbox access token");
  }
  if (allowedRecipients.length === 0 || allowedRecipients.length > 5 ||
      allowedRecipients.some((value) => !/^\d{7,20}$/u.test(value))) {
    throw new Error("Sandbox recipients must contain one to five international phone numbers");
  }

  let tokenExpiresAt: string | undefined;
  if (env.META_SANDBOX_TOKEN_EXPIRES_AT) {
    const parsed = new Date(env.META_SANDBOX_TOKEN_EXPIRES_AT);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== env.META_SANDBOX_TOKEN_EXPIRES_AT) {
      throw new Error("Invalid sandbox token expiry");
    }
    tokenExpiresAt = env.META_SANDBOX_TOKEN_EXPIRES_AT;
  }

  return {
    tenantId,
    wabaId,
    phoneNumberId,
    accessToken,
    allowedRecipients,
    ...(tokenExpiresAt ? { tokenExpiresAt } : {})
  };
}

export function sandboxRecipientAllowed(
  config: WhatsAppSandboxConfig | null,
  tenantId: string,
  recipient: string
): boolean {
  return !config || tenantId !== config.tenantId || config.allowedRecipients.includes(recipient);
}
