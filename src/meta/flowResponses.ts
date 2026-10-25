import { z } from "zod";
import { sha256Base64Url } from "./pilotCrypto.js";

export const flowKindSchema = z.enum(["visit", "wholesale"]);
export type SandboxFlowKind = z.infer<typeof flowKindSchema>;

// Match the existing visit-schedule.json / wholesale-profile.json assets.
const visitAnswersSchema = z.object({
  customer_name: z.string().trim().min(1).max(200),
  phone: z.string().trim().regex(/^[+() .0-9-]{7,40}$/u),
  visit_date: z.iso.date(),
  visit_time: z.enum(["10_00_am", "11_00_am", "12_00_pm", "1_00_pm", "2_00_pm", "3_00_pm", "4_00_pm", "5_00_pm", "6_00_pm", "7_00_pm"]),
  notes: z.string().max(2000).optional()
}).strict();
const wholesaleAnswersSchema = z.object({
  city: z.string().trim().min(1).max(200),
  budget_range: z.enum(["under_200", "200_500", "500_1m", "over_1m"]),
  selling_status: z.enum(["physical_store", "whatsapp", "both", "not_yet"])
}).strict();
export const flowFormSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visit"), answers: visitAnswersSchema }).strict(),
  z.object({ kind: z.literal("wholesale"), answers: wholesaleAnswersSchema }).strict()
]);
export type FlowForm = z.infer<typeof flowFormSchema>;
export const flowValidationErrorsSchema = z.array(z.object({
  field: z.enum(["response", "token", "source", "customer_name", "phone", "visit_date", "visit_time", "notes", "city", "budget_range", "selling_status"]),
  code: z.enum(["required", "invalid_type", "invalid_format", "too_short", "too_long", "unsupported_value", "unsupported_field", "malformed", "too_large"])
}).strict()).min(1).max(12);
export type FlowValidationError = z.infer<typeof flowValidationErrorsSchema>[number];
export const flowSubmissionSchema = z.union([
  z.object({ status: z.literal("completed"), form: flowFormSchema }).strict(),
  z.object({ status: z.literal("invalid"), validationErrors: flowValidationErrorsSchema.optional() }).strict(),
  z.object({ status: z.enum(["unmatched", "duplicate"]) }).strict()
]);
export type StoredFlowSubmission = z.infer<typeof flowSubmissionSchema>;

/** Internal-only correlation candidate. Never include the raw token/JSON. */
export type FlowReplyCandidate = { tokenHash?: string; contextMessageRef?: string; form?: FlowForm; validationErrors?: FlowValidationError[] };

/** Only closed-vocabulary diagnostics cross storage/API boundaries, never Zod messages or rejected values. */
export function invalidFlowSubmission(candidate: FlowReplyCandidate): StoredFlowSubmission {
  const errors = flowValidationErrorsSchema.safeParse(candidate.validationErrors);
  return { status: "invalid", ...(errors.success ? { validationErrors: errors.data } : {}) };
}
export type InternalFlowLaunch = {
  tokenHash: string;
  conversationRef: string;
  kind: SandboxFlowKind;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: string;
  expiresAt: string;
};

export async function flowToken(secret: string, tenantId: string, conversationRef: string, idempotencyKey: string): Promise<string> {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", bytes.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key,
    bytes.encode(JSON.stringify(["whatsapp-draft-flow", tenantId, conversationRef, idempotencyKey]))));
  return `flow_${btoa(String.fromCharCode(...signature)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "")}`;
}

/** Return undefined for non-Flow messages; rejected input retains only bounded value-free diagnostics. */
export async function parseFlowReply(message: Record<string, unknown>): Promise<FlowReplyCandidate | undefined> {
  const interactive = record(message.interactive);
  if (message.type !== "interactive" || interactive?.type !== "nfm_reply") return undefined;
  const encoded = record(interactive.nfm_reply)?.response_json;
  if (typeof encoded !== "string") return { validationErrors: [{ field: "response", code: "invalid_type" }] };
  if (new TextEncoder().encode(encoded).byteLength > 8192) return { validationErrors: [{ field: "response", code: "too_large" }] };
  let parsed: Record<string, unknown> | undefined;
  try { parsed = record(JSON.parse(encoded)); } catch { return { validationErrors: [{ field: "response", code: "malformed" }] }; }
  if (!parsed) return { validationErrors: [{ field: "response", code: "invalid_type" }] };
  const { flow_token: token, source, ...answers } = parsed;
  const candidate: FlowReplyCandidate = {};
  const errors: FlowValidationError[] = [];
  if (typeof token === "string" && /^flow_[A-Za-z0-9_-]{43}$/u.test(token)) candidate.tokenHash = await sha256Base64Url(token);
  else errors.push({ field: "token", code: token === undefined ? "required" : "invalid_format" });
  const context = record(message.context)?.id;
  if (typeof context === "string" && context.length > 0 && context.length <= 512) candidate.contextMessageRef = context;
  const kind = source === "visit_schedule_flow" ? "visit" : source === "wholesale_flow" ? "wholesale" : undefined;
  if (!kind) {
    errors.push({ field: "source", code: source === undefined ? "required" : "unsupported_value" });
    candidate.validationErrors = errors;
    return candidate;
  }
  // Optional form fields may arrive as null. Normalize internally, keeping the
  // advertised MCP JSON Schema free of non-serializable Zod transforms.
  if (kind === "visit" && answers.notes === null) delete answers.notes;
  const validated = flowFormSchema.safeParse({ kind, answers });
  if (validated.success) candidate.form = validated.data;
  else {
    const fields = new Set(["customer_name", "phone", "visit_date", "visit_time", "notes", "city", "budget_range", "selling_status"]);
    for (const issue of validated.error.issues) {
      const name = issue.path[0] === "answers" && typeof issue.path[1] === "string" && fields.has(issue.path[1]) ? issue.path[1] : "response";
      const field = name as FlowValidationError["field"];
      const code: FlowValidationError["code"] = issue.code === "unrecognized_keys" ? "unsupported_field"
        : issue.code === "too_small" ? "too_short" : issue.code === "too_big" ? "too_long"
        : issue.code === "invalid_value" ? "unsupported_value"
        : issue.code === "invalid_type" ? (answers[name] === undefined ? "required" : "invalid_type") : "invalid_format";
      if (!errors.some(error => error.field === field && error.code === code)) errors.push({ field, code });
    }
  }
  if (errors.length) candidate.validationErrors = errors.slice(0, 12);
  return candidate;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
