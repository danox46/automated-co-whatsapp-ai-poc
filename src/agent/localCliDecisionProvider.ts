import { spawn } from "node:child_process";
import { z } from "zod";
import type { AgentDecision, AgentDecisionProvider, AgentDecisionRequest } from "./decisionTypes.js";

const agentDecisionSchema = z.object({
  action: z.enum(["respond", "route_to_human"]),
  responseText: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  routeReason: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  confidence: z.number().min(0).max(1).default(0.5),
  understanding: z.object({
    intent: z.enum(["check_availability", "delivery_guidance", "unclear"]),
    resolvedIntent: z.union([
      z.enum(["check_availability", "delivery_guidance", "unclear"]),
      z.literal("catalog_options")
    ]),
    needsHuman: z.boolean()
  }),
  notes: z.array(z.string()).default([])
});

export type LocalCliDecisionProviderConfig = {
  command: string;
  timeoutMs: number;
};

export class LocalCliDecisionProvider implements AgentDecisionProvider {
  constructor(private readonly config: LocalCliDecisionProviderConfig) {}

  async decide(request: AgentDecisionRequest): Promise<AgentDecision> {
    const stdout = await runCommandWithJsonInput(
      this.config.command,
      request,
      this.config.timeoutMs
    );
    const parsed = JSON.parse(stdout) as unknown;
    return agentDecisionSchema.parse(parsed);
  }
}

function runCommandWithJsonInput(command: string, input: unknown, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Agent CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`Agent CLI exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      resolve(stdout.trim());
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
