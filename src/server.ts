import "dotenv/config";
import { createOperatorApp, createWebhookApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { createOperatorRuntime } from "./operator/runtime.js";

const config = loadConfig();
const runtime = await createOperatorRuntime(config);
const webhookApp = createWebhookApp(config, runtime);
const operatorApp = createOperatorApp(config, runtime);

const webhookServer = webhookApp.listen(config.webhookPort, () => {
  logger.info("Twilio webhook listener started", { port: config.webhookPort });
});
const operatorServer = operatorApp.listen(config.operatorPort, config.operatorHost, () => {
  const url = `http://${config.operatorHost}:${config.operatorPort}`;
  console.log(`\nLocal operator inbox: ${url}`);
  console.log(`Database: ready | Twilio: ${twilioReadiness()} | Tunnel: ${config.twilio.webhookPublicUrl ? "configured" : "not configured"}\n`);
});

function twilioReadiness() {
  return config.twilio.accountSid && config.twilio.authToken && config.twilio.whatsappFrom
    ? "configured"
    : "not configured";
}

function shutdown() {
  webhookServer.close();
  operatorServer.close(() => {
    runtime.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
