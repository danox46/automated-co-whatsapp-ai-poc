import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import type { AppConfig } from "./config/env.js";
import type { OperatorRuntime } from "./operator/runtime.js";
import { healthRouter } from "./routes/health.js";
import { createOperatorApiRouter } from "./routes/operatorApi.js";
import { createTwilioWebhookRouter } from "./routes/twilioWebhook.js";

export function createWebhookApp(config: AppConfig, runtime: OperatorRuntime) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use("/health", healthRouter);
  app.use("/webhooks/twilio", createTwilioWebhookRouter(config, runtime));
  return app;
}

export function createOperatorApp(config: AppConfig, runtime: OperatorRuntime) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", createOperatorApiRouter(config, runtime));

  const uiPath = resolve("operator-ui/dist");
  if (existsSync(uiPath)) {
    app.use(express.static(uiPath, { index: false }));
    app.get("*", (_req, res) => res.sendFile(resolve(uiPath, "index.html")));
  } else {
    app.get("/", (_req, res) => res.status(503).send("Operator UI is not built. Run npm run build."));
  }
  return app;
}
