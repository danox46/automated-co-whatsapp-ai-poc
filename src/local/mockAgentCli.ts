import { DeterministicDecisionProvider } from "../agent/deterministicDecisionProvider.js";
import type { AgentDecisionRequest } from "../agent/decisionTypes.js";

const chunks: Buffer[] = [];

for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AgentDecisionRequest;
const decision = await new DeterministicDecisionProvider().decide(input);

process.stdout.write(JSON.stringify(decision));
