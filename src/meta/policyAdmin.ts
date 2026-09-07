import type { DurableConversationNamespace } from "../mcp/durableConversationStore.js";
import { decryptPilotSecret, secureEqualText } from "./pilotCrypto.js";
import type { createMetaGraphClient } from "./graphClient.js";
import type { createPilotInstallationRegistry } from "./pilotInstallationStore.js";

const MAX_JSON_BYTES = 32 * 1024;

export function createWhatsAppPolicyAdminHandler(input: {
  adminToken: string;
  conversations: DurableConversationNamespace;
  registry: ReturnType<typeof createPilotInstallationRegistry>;
  graph: ReturnType<typeof createMetaGraphClient>;
  encryptionKey: string;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const template = /^\/admin\/pilot\/tenants\/([a-z0-9][a-z0-9_-]{2,63})\/templates\/([A-Za-z0-9_.-]{1,128})$/u.exec(url.pathname);
      const consent = /^\/admin\/pilot\/tenants\/([a-z0-9][a-z0-9_-]{2,63})\/conversations\/([A-Za-z0-9_-]{8,200})\/template-consent$/u.exec(url.pathname);
      const policy = /^\/admin\/pilot\/tenants\/([a-z0-9][a-z0-9_-]{2,63})\/conversations\/([A-Za-z0-9_-]{8,200})\/policy$/u.exec(url.pathname);
      if (!template && !consent && !policy) return null;
      if (request.method !== "PUT") return jsonError("METHOD_NOT_ALLOWED", "Use PUT for this pilot policy route.", 405);
      if (!await isAdmin(request, input.adminToken)) return unauthorized();
      if (template) return upsertTemplate(request, template[1], template[2]);
      if (consent) return setConsent(request, consent[1], consent[2]);
      return setPolicy(request, policy![1], policy![2]);
    }
  };

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
