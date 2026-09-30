import type { DurableConversationNamespace } from "../mcp/durableConversationStore.js";
import type { InternalStoredAttachment } from "../mcp/conversationHistory.js";
import { decryptPilotSecret, secureEqualText } from "./pilotCrypto.js";
import type { createMetaGraphClient } from "./graphClient.js";
import type { AttachmentCaptureResult } from "./attachmentCapture.js";
import type { createPilotInstallationRegistry } from "./pilotInstallationStore.js";

const MAX_JSON_BYTES = 32 * 1024;

export function createWhatsAppPolicyAdminHandler(input: {
  adminToken: string;
  conversations: DurableConversationNamespace;
  registry: ReturnType<typeof createPilotInstallationRegistry>;
  graph: ReturnType<typeof createMetaGraphClient>;
  encryptionKey: string;
  captureAttachment?: (attachment: InternalStoredAttachment & { tenantId: string }) => Promise<AttachmentCaptureResult>;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const template = /^\/admin\/pilot\/tenants\/([a-z0-9][a-z0-9_-]{2,63})\/templates\/([A-Za-z0-9_.-]{1,128})$/u.exec(url.pathname);
      const consent = /^\/admin\/pilot\/tenants\/([a-z0-9][a-z0-9_-]{2,63})\/conversations\/([A-Za-z0-9_-]{8,200})\/template-consent$/u.exec(url.pathname);
      const policy = /^\/admin\/pilot\/tenants\/([a-z0-9][a-z0-9_-]{2,63})\/conversations\/([A-Za-z0-9_-]{8,200})\/policy$/u.exec(url.pathname);
      const conversations = /^\/admin\/pilot\/tenants\/([a-z0-9][a-z0-9_-]{2,63})\/conversations$/u.exec(url.pathname);
      const history = /^\/admin\/pilot\/tenants\/([a-z0-9][a-z0-9_-]{2,63})\/conversations\/([A-Za-z0-9_-]{8,200})\/history$/u.exec(url.pathname);
      const attachmentCapture = /^\/admin\/pilot\/tenants\/([a-z0-9][a-z0-9_-]{2,63})\/conversations\/([A-Za-z0-9_-]{8,200})\/attachments\/(att_[A-Za-z0-9_-]{32})\/capture$/u.exec(url.pathname);
      if (!template && !consent && !policy && !conversations && !history && !attachmentCapture) return null;
      if (!await isAdmin(request, input.adminToken)) return unauthorized();
      if (conversations && request.method === "GET") return listConversations(conversations[1]);
      if (history && request.method === "GET") return getConversationHistory(history[1], history[2], url);
      if (attachmentCapture && request.method === "POST") {
        return captureAttachment(attachmentCapture[1], attachmentCapture[2], attachmentCapture[3]);
      }
      if (request.method !== "PUT") return jsonError("METHOD_NOT_ALLOWED", "Use GET for structured records or PUT for policy changes.", 405);
      if (template) return upsertTemplate(request, template[1], template[2]);
      if (consent) return setConsent(request, consent[1], consent[2]);
      return setPolicy(request, policy![1], policy![2]);
    }
  };

  async function listConversations(tenantId: string) {
    const stub = await initializedTenant(tenantId);
    const result = await stub.listConversations({ limit: 50 });
    return json({ ok: true, ...result });
  }

  async function getConversationHistory(tenantId: string, conversationRef: string, url: URL) {
    const limitValue = Number(url.searchParams.get("limit") ?? "100");
    const limit = Number.isInteger(limitValue) && limitValue >= 1 && limitValue <= 200 ? limitValue : 100;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const stub = await initializedTenant(tenantId);
    const result = await stub.getConversationHistory({ conversationRef, limit, ...(cursor ? { cursor } : {}) });
    if (!result) return jsonError("PILOT_CONVERSATION_NOT_FOUND", "The tenant-scoped conversation is unavailable.", 404);
    return json({ ok: true, ...result });
  }

  async function captureAttachment(tenantId: string, conversationRef: string, attachmentRef: string) {
    if (!input.captureAttachment) {
      return jsonError("PILOT_ATTACHMENT_CAPTURE_UNAVAILABLE", "Attachment capture is not configured.", 503);
    }
    const stub = await initializedTenant(tenantId);
    const attachment = await stub.getAttachment(conversationRef, attachmentRef);
    if (!attachment) {
      return jsonError("PILOT_ATTACHMENT_NOT_FOUND", "The tenant-scoped attachment is unavailable.", 404);
    }
    try {
      const result = await input.captureAttachment({ tenantId, ...attachment });
      const updated = await stub.getAttachment(conversationRef, attachmentRef);
      return json({
        ok: true,
        attachment: updated ? {
          attachmentRef: updated.attachmentRef,
          kind: updated.kind,
          mimeType: updated.mimeType,
          state: updated.state,
          ...(updated.sizeBytes !== undefined ? { sizeBytes: updated.sizeBytes } : {}),
          ...(result.reason ? { diagnostic: result.reason } : {})
        } : null
      });
    } catch (error) {
      const diagnostic = error instanceof Error && /^[A-Z0-9_]{3,160}$/u.test(error.message)
        ? error.message
        : "ATTACHMENT_CAPTURE_RETRYABLE_FAILURE";
      return jsonError(diagnostic, "The provider attachment could not be captured yet.", 502);
    }
  }

  async function upsertTemplate(request: Request, tenantId: string, templateName: string) {
    const body = await readBoundedJson(request);
    const languageCode = readPolicyValue(body?.languageCode, 35);
    const purpose = readPolicyValue(body?.purpose, 128);
    const enabled = body?.enabled;
    if (!languageCode || !purpose || typeof enabled !== "boolean") {
      return jsonError("PILOT_TEMPLATE_POLICY_INVALID", "Expected languageCode, purpose, and enabled.", 400);
    }
    const installation = await input.registry.getInstallation(tenantId);
    if (!installation || installation.status !== "connected") {
      return jsonError("PILOT_INSTALLATION_NOT_CONNECTED", "Connect this tenant before configuring templates.", 409);
    }
    const accessToken = await decryptPilotSecret(installation.encryptedAccessToken, input.encryptionKey);
    let verified;
    try {
      verified = await input.graph.verifyApprovedTemplate(
        accessToken,
        installation.wabaId,
        templateName,
        languageCode
      );
    } catch {
      return jsonError("PILOT_TEMPLATE_NOT_PROVIDER_APPROVED", "Meta does not report this exact template and language as approved.", 409);
    }
    const stub = await initializedTenant(tenantId);
    await stub.upsertApprovedTemplate({
      name: verified.name,
      category: verified.category,
      purpose,
      languageCode: verified.languageCode,
      enabled
    });
    return json({ ok: true, template: { ...verified, purpose, enabled } });
  }

  async function setConsent(request: Request, tenantId: string, conversationRef: string) {
    const body = await readBoundedJson(request);
    const categories = readPolicyArray(body?.categories);
    const purposes = readPolicyArray(body?.purposes);
    const policyRevision = readPolicyValue(body?.policyRevision, 128);
    if (!categories || !purposes || !policyRevision) {
      return jsonError("PILOT_TEMPLATE_CONSENT_INVALID", "Expected bounded categories, purposes, and a policy revision.", 400);
    }
    const stub = await initializedTenant(tenantId);
    try {
      await stub.setConversationTemplateConsent({
        conversationRef,
        categories,
        purposes,
        policyRevision,
        updatedAt: now().toISOString()
      });
    } catch {
      return jsonError("PILOT_CONVERSATION_NOT_FOUND", "The tenant-scoped conversation is unavailable.", 404);
    }
    return json({ ok: true, conversationRef, policyRevision, consentRecorded: true });
  }

  async function setPolicy(request: Request, tenantId: string, conversationRef: string) {
    const body = await readBoundedJson(request);
    const policyRevision = readPolicyValue(body?.policyRevision, 128);
    const recipientOptedOut = body?.recipientOptedOut;
    const automationPaused = body?.automationPaused;
    if (!policyRevision || (recipientOptedOut !== undefined && typeof recipientOptedOut !== "boolean") ||
        (automationPaused !== undefined && typeof automationPaused !== "boolean") ||
        (recipientOptedOut === undefined && automationPaused === undefined)) {
      return jsonError("PILOT_CONVERSATION_POLICY_INVALID", "Expected a policy revision and at least one boolean policy control.", 400);
    }
    const stub = await initializedTenant(tenantId);
    const existing = await stub.getConversationEnforcementState(conversationRef);
    if (!existing) {
      return jsonError("PILOT_CONVERSATION_NOT_FOUND", "The tenant-scoped conversation is unavailable.", 404);
    }
    await stub.updatePolicyState({
      conversationRef,
      policyRevision,
      ...(typeof recipientOptedOut === "boolean" ? { recipientOptedOut } : {}),
      ...(typeof automationPaused === "boolean" ? { automationPaused } : {})
    });
    return json({ ok: true, conversationRef, policyRevision, policyUpdated: true });
  }

  async function initializedTenant(tenantId: string) {
    const stub = input.conversations.getByName(tenantId);
    await stub.initializeTenant(tenantId);
    return stub;
  }
}

async function isAdmin(request: Request, expected: string): Promise<boolean> {
  const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
  return Boolean(match && expected && await secureEqualText(match[1], expected));
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_JSON_BYTES) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readPolicyValue(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max && /^[A-Za-z0-9_.-]+$/u.test(value) ? value : null;
}

function readPolicyArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const result = value.map((item) => readPolicyValue(item, 128));
  return result.every(Boolean) ? result as string[] : null;
}

function unauthorized(): Response {
  const response = jsonError("PILOT_ADMIN_AUTH_REQUIRED", "Valid pilot administrator authorization is required.", 401);
  response.headers.set("WWW-Authenticate", "Bearer");
  return response;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: responseHeaders() });
}

function jsonError(code: string, message: string, status: number): Response {
  return json({ ok: false, error: { code, message } }, status);
}

function responseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
}
