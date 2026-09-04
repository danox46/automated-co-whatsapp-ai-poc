import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WEBHOOK_PORT: z.coerce.number().int().positive().default(3000),
  OPERATOR_PORT: z.coerce.number().int().positive().default(3100),
  OPERATOR_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  WEBHOOK_EVENT_LOG_PATH: z.string().default(".runtime/webhook-events.jsonl"),
  OPERATOR_DATABASE_PATH: z.string().default(".runtime/operator-inbox.sqlite"),
  OPERATOR_MEDIA_PATH: z.string().default(".runtime/media"),
  OPERATOR_SETTINGS_PATH: z.string().default(".runtime/operator-settings.json"),
  OPERATOR_DEMO_MODE: z.enum(["true", "false"]).default("false"),
  INBOUND_IDLE_BUFFER_MS: z.coerce.number().int().nonnegative().default(5000),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  TWILIO_ADMIN_REVIEW_TO: z.string().optional(),
  TWILIO_WEBHOOK_PUBLIC_URL: z.string().optional(),
  INVENTORY_PROVIDER: z.enum(["mock_grocery", "shopify_placeholder"]).default("mock_grocery"),
  AGENT_DECISION_MODE: z.enum(["deterministic", "local_cli"]).default("deterministic"),
  AGENT_LOCAL_CLI_COMMAND: z.string().optional(),
  AGENT_LOCAL_CLI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  SHOPIFY_STORE_DOMAIN: z.string().optional()
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const env = envSchema.parse(process.env);

  return {
    nodeEnv: env.NODE_ENV,
    webhookPort: env.WEBHOOK_PORT,
    operatorPort: env.OPERATOR_PORT,
    operatorHost: env.OPERATOR_HOST,
    logLevel: env.LOG_LEVEL,
    webhookEventLog: {
      path: env.WEBHOOK_EVENT_LOG_PATH
    },
    operator: {
      databasePath: env.OPERATOR_DATABASE_PATH,
      mediaPath: env.OPERATOR_MEDIA_PATH,
      settingsPath: env.OPERATOR_SETTINGS_PATH,
      demoMode: env.OPERATOR_DEMO_MODE === "true"
    },
    inboundBuffer: {
      idleMs: env.INBOUND_IDLE_BUFFER_MS
    },
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      whatsappFrom: env.TWILIO_WHATSAPP_FROM,
      adminReviewTo: env.TWILIO_ADMIN_REVIEW_TO,
      webhookPublicUrl: env.TWILIO_WEBHOOK_PUBLIC_URL
    },
    inventory: {
      provider: env.INVENTORY_PROVIDER
    },
    agent: {
      mode: env.AGENT_DECISION_MODE,
      command: env.AGENT_LOCAL_CLI_COMMAND,
      timeoutMs: env.AGENT_LOCAL_CLI_TIMEOUT_MS
    },
    shopify: {
      storeDomain: env.SHOPIFY_STORE_DOMAIN
    }
  };
}

export function validateRuntimeConfig(config: AppConfig) {
  const missing: string[] = [];

  if (!config.twilio.accountSid) {
    missing.push("TWILIO_ACCOUNT_SID");
  }

  if (!config.twilio.authToken) {
    missing.push("TWILIO_AUTH_TOKEN");
  }

  if (!config.twilio.whatsappFrom) {
    missing.push("TWILIO_WHATSAPP_FROM");
  }

  if (config.agent.mode === "local_cli" && !config.agent.command) {
    missing.push("AGENT_LOCAL_CLI_COMMAND");
  }

  return {
    ok: missing.length === 0,
    missing
  };
}
