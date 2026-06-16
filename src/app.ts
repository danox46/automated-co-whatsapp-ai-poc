import express from "express";
import type { AppConfig } from "./config/env.js";
import { healthRouter } from "./routes/health.js";
import { createTwilioWebhookRouter } from "./routes/twilioWebhook.js";

export function createApp(config: AppConfig) {
  const app = express();

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.use("/health", healthRouter);
  app.use("/webhooks/twilio", createTwilioWebhookRouter(config));

  return app;
}
