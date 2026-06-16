import type { AppConfig } from "../config/env.js";
import type { AgentDecisionProvider } from "./decisionTypes.js";
import { DeterministicDecisionProvider } from "./deterministicDecisionProvider.js";
import { LocalCliDecisionProvider } from "./localCliDecisionProvider.js";

export function createDecisionProvider(config: AppConfig): AgentDecisionProvider {
  if (config.agent.mode === "local_cli") {
    if (!config.agent.command) {
      throw new Error("AGENT_LOCAL_CLI_COMMAND is required when AGENT_DECISION_MODE=local_cli.");
    }

    return new LocalCliDecisionProvider({
      command: config.agent.command,
      timeoutMs: config.agent.timeoutMs
    });
  }

  return new DeterministicDecisionProvider();
}
