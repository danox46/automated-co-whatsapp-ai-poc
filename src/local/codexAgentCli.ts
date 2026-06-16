import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDecisionRequest } from "../agent/decisionTypes.js";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const schemaPath = join(workspaceRoot, "schemas", "agent-decision.schema.json");
const defaultPromptPath = join(workspaceRoot, "prompts", "local-codex-agent.md");

const request = (await readStdinJson()) as AgentDecisionRequest;
const tempDir = await mkdtemp(join(tmpdir(), "whatsapp-codex-agent-"));
const outputPath = join(tempDir, "decision.json");

try {
  const codexPath = resolveCodexCliPath();
  const prompt = buildPrompt(request);

  await runCodex(codexPath, prompt, outputPath);

  const finalMessage = (await readFile(outputPath, "utf8")).trim();
  const decision = extractJson(finalMessage);
  process.stdout.write(JSON.stringify(decision));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function readStdinJson() {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function resolveCodexCliPath() {
  if (process.env.CODEX_CLI_PATH) {
    return process.env.CODEX_CLI_PATH;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const candidate = join(localAppData, "OpenAI", "Codex", "bin", "f1c7ee7a13db5fed", "codex.exe");
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "codex";
}

function buildPrompt(request: AgentDecisionRequest) {
  const promptPath = process.env.AGENT_PROMPT_PATH
    ? resolve(workspaceRoot, process.env.AGENT_PROMPT_PATH)
    : defaultPromptPath;
  const basePrompt = readFileSync(promptPath, "utf8");

  return `${basePrompt}

## Decision Request JSON

${JSON.stringify(request, null, 2)}`;
}

function runCodex(codexPath: string, prompt: string, outputPath: string) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      codexPath,
      [
        "exec",
        "--cd",
        workspaceRoot,
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-"
      ],
      {
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Codex CLI exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      resolvePromise();
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Codex final message did not contain JSON.");
    }

    return JSON.parse(match[0]);
  }
}
