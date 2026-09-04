import type { AppConfig } from "../config/env.js";
import { OperatorEventHub } from "./eventHub.js";
import { openOperatorDatabase } from "../persistence/database.js";
import { importLegacyWebhookLogOnce } from "../persistence/importLegacyLog.js";
import { OperatorRepository } from "../persistence/operatorRepository.js";
import { OperatorSettingsManager } from "../settings/operatorSettings.js";
import { sendWhatsappMessage, type TwilioOutboundMessage, type TwilioSendConfig, type TwilioSendResult } from "../twilio/sendService.js";

export type OutboundSender = (
  config: TwilioSendConfig,
  message: TwilioOutboundMessage
) => Promise<TwilioSendResult>;

export type OperatorRuntime = {
  repository: OperatorRepository;
  events: OperatorEventHub;
  settings: OperatorSettingsManager;
  sendMessage: OutboundSender;
  close: () => void;
};

export async function createOperatorRuntime(config: AppConfig): Promise<OperatorRuntime> {
  const database = openOperatorDatabase(config.operator.databasePath);
  const repository = new OperatorRepository(database);
  const events = new OperatorEventHub();
  const settings = new OperatorSettingsManager(config.operator.settingsPath, (event) => {
    repository.recordAudit(`settings_${event.type}`, event);
    events.publish({ type: event.type === "loaded" ? "settings.loaded" : "settings.invalid", data: event });
  });
  await settings.start();
  await importLegacyWebhookLogOnce(repository, config.webhookEventLog.path);

  return {
    repository,
    events,
    settings,
    sendMessage: config.operator.demoMode ? createDemoSender() : sendWhatsappMessage,
    close: () => {
      settings.stop();
      database.close();
    }
  };
}

function createDemoSender(): OutboundSender {
  return async () => ({
    sid: `LOCAL_${Date.now()}`,
    status: "sent",
    direction: "outbound-api"
  });
}
