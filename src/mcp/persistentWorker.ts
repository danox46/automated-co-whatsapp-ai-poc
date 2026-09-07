import {
  createDurableConversationReader,
  createDurableConversationRetentionController,
  createDurableConversationWriter,
  WhatsAppConversationDurableObject,
  type DurableConversationNamespace
} from "./durableConversationStore.js";
import { conversationRetentionPolicyFromEnv } from "./retentionPolicy.js";
import {
  createProtectedWhatsAppMcpHandler,
  type CreateWhatsAppMcpHandlerOptions
} from "./server.js";
import {
  handleMetaWhatsAppWebhook,
  metaWebhookWabaIds,
  type MetaWebhookEnv
} from "../meta/webhook.js";
import { createMetaGraphClient } from "../meta/graphClient.js";
import {
  createPilotInstallationRegistry,
  WhatsAppPilotInstallationDurableObject,
  type PilotInstallationNamespace
} from "../meta/pilotInstallationStore.js";
import {
  createPilotOnboardingHandler,
  PILOT_SESSION_COOKIE,
  type PilotOnboardingEnv
} from "../meta/pilotOnboarding.js";
import {
  createWhatsAppAuthorizationServer,
  createStaticOAuthClientRegistry
} from "../oauth/authorizationServer.js";
import {
  createDurableOAuthState,
  WhatsAppOAuthStateDurableObject,
  type OAuthStateNamespace
} from "../oauth/durableAuthorizationStore.js";
import { createJwtWhatsAppMcpTokenVerifier } from "./jwtTokenVerifier.js";
import {
  createDurableWhatsAppPolicyDirectory,
  createMetaMessagingCapability
} from "../meta/messagingCapability.js";
import { createWhatsAppPolicyAdminHandler } from "../meta/policyAdmin.js";

export type PersistentWhatsAppWorkerEnv = MetaWebhookEnv & {
  CONVERSATIONS: DurableConversationNamespace;
  PILOT_INSTALLATIONS: PilotInstallationNamespace;
  OAUTH_STATE: OAuthStateNamespace;
  CONVERSATION_REF_SECRET: string;
  META_APP_ID?: string;
  META_GRAPH_API_VERSION?: string;
  META_EMBEDDED_SIGNUP_CONFIG_ID?: string;
  META_EMBEDDED_SIGNUP_SESSION_VERSION?: string;
  INSTALLATION_ENCRYPTION_KEY?: string;
  PILOT_ADMIN_TOKEN?: string;
  PUBLIC_ORIGIN?: string;
  OAUTH_SIGNING_KEY_ID?: string;
  OAUTH_SIGNING_PRIVATE_JWK?: string;
  OAUTH_SIGNING_PUBLIC_JWK?: string;
  OAUTH_CLIENT_ID?: string;
  OAUTH_REDIRECT_URI?: string;
  CONVERSATION_MESSAGE_RETENTION_DAYS?: string;
  CONVERSATION_INACTIVE_RETENTION_DAYS?: string;
  CONVERSATION_PENDING_STATUS_RETENTION_DAYS?: string;
  CONVERSATION_RETENTION_INTERVAL_HOURS?: string;
};

export type PersistentWhatsAppWorkerOptions = Pick<
  CreateWhatsAppMcpHandlerOptions,
  "verifyToken" | "messaging"
>;

export {
  WhatsAppConversationDurableObject,
  WhatsAppPilotInstallationDurableObject,
  WhatsAppOAuthStateDurableObject
};

export function createPersistentWhatsAppWorker(
  options: PersistentWhatsAppWorkerOptions = {}
) {
  return {
    async fetch(request: Request, env: PersistentWhatsAppWorkerEnv): Promise<Response> {
      const retentionPolicy = conversationRetentionPolicyFromEnv(env);
      const writer = createDurableConversationWriter(env.CONVERSATIONS, retentionPolicy);
      const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
      const oauthState = createDurableOAuthState(env.OAUTH_STATE);
      const oauthConfigured = hasOAuthConfiguration(env);
      const pilotConfigured = hasPilotConfiguration(env) && oauthConfigured;
      const pathname = new URL(request.url).pathname;
      const graph = pilotConfigured ? createMetaGraphClient({
        appId: env.META_APP_ID as string,
        appSecret: env.META_APP_SECRET,
        graphVersion: env.META_GRAPH_API_VERSION as string
      }) : null;
      const runtimeMessaging = options.messaging ?? (graph ? createMetaMessagingCapability({
        conversations: env.CONVERSATIONS,
        registry,
        graph,
        encryptionKey: env.INSTALLATION_ENCRYPTION_KEY as string,
        policyDirectory: createDurableWhatsAppPolicyDirectory(env.CONVERSATIONS)
      }) : undefined);

      let runtimeTokenVerifier = options.verifyToken;
      let resource = safePublicOrigin(env.PUBLIC_ORIGIN);
      if (oauthConfigured && resource) {
        const signingKey = parseSigningKey(env);
        const authorizationServer = createWhatsAppAuthorizationServer({
          issuer: resource,
          resource,
          signingKey,
          clients: createStaticOAuthClientRegistry([{
            clientId: env.OAUTH_CLIENT_ID ?? "https://chatgpt.com/oauth/client.json",
            redirectUris: [env.OAUTH_REDIRECT_URI ?? "https://chatgpt.com/connector_platform_oauth_redirect"]
          }]),
          store: oauthState.store,
          resolveSession: async (authorizationRequest) => {
            const rawSession = readCookie(authorizationRequest, PILOT_SESSION_COOKIE);
            return rawSession ? oauthState.resolvePilotSession(rawSession) : null;
          },
          clientIdMetadataDocumentSupported: true
        });
        const authorizationResponse = await authorizationServer.fetch(request);
        if (authorizationResponse) return authorizationResponse;
        const jwtVerifier = createJwtWhatsAppMcpTokenVerifier({
          issuer: resource,
          audience: resource,
          resolvePublicJwk: async (header) =>
            header.kid === signingKey.kid ? signingKey.publicJwk : null,
          isTokenRevoked: oauthState.isAccessTokenRevoked
        });
        runtimeTokenVerifier ??= async (token, tokenRequest) => {
          const principal = await jwtVerifier(token, tokenRequest);
          if (!principal) return null;
          const installation = await registry.getInstallation(principal.tenantId);
          return installation?.status === "connected" ? principal : null;
        };
      }

      if (pathname.startsWith("/pilot/whatsapp/") || pathname.startsWith("/admin/pilot/")) {
        if (!pilotConfigured) {
          return Response.json({
            ok: false,
            error: {
              code: "PILOT_CONFIGURATION_REQUIRED",
              message: "The closed-pilot onboarding service is not configured."
            }
          }, { status: 503, headers: noStoreHeaders() });
        }
        const pilot = createPilotOnboardingHandler(env as PersistentWhatsAppWorkerEnv & PilotOnboardingEnv, {
          registry,
          graph: graph as ReturnType<typeof createMetaGraphClient>,
          deleteConversationData: async (tenantId) =>
            createDurableConversationRetentionController(env.CONVERSATIONS)
              .deleteAllConversationData(tenantId),
          createAuthorizationSession: oauthState.createPilotSession,
          revokeAuthorizationSessions: oauthState.revokeTenant
        });
        const policyAdmin = createWhatsAppPolicyAdminHandler({
          adminToken: env.PILOT_ADMIN_TOKEN as string,
          conversations: env.CONVERSATIONS,
          registry,
          graph: graph as ReturnType<typeof createMetaGraphClient>,
          encryptionKey: env.INSTALLATION_ENCRYPTION_KEY as string
        });
        const policyResponse = await policyAdmin.fetch(request);
        if (policyResponse) return policyResponse;
        const response = await pilot.fetch(request);
        if (response) return response;
      }

      const webhookResponse = await handleMetaWhatsAppWebhook(request, env, async (payload) => {
        const wabaIds = metaWebhookWabaIds(payload);
        if (wabaIds.length !== 1) return null;
        const tenantId = await registry.resolveTenantForWaba(wabaIds[0]);
        return tenantId ? {
          tenantId,
          conversationRefSecret: env.CONVERSATION_REF_SECRET,
          writer
        } : null;
      });
      if (webhookResponse) return webhookResponse;

      if (new URL(request.url).pathname === "/health") {
        return Response.json({
          ok: true,
          conversationPersistence: "durable-object-sqlite",
          rawWebhookPayloadRetention: false,
          retention: retentionPolicy,
          conversationReadTools: true,
          pilotOnboardingConfigured: pilotConfigured,
          oauthConfigured,
          tenantRouting: "waba-sharded",
          oauthVerifierConfigured: Boolean(runtimeTokenVerifier),
          outboundMessagingConfigured: Boolean(runtimeMessaging)
        }, {
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      const handler = createProtectedWhatsAppMcpHandler({
        resource: resource ?? "https://unconfigured.invalid",
        authorizationServer: resource ?? "https://unconfigured.invalid",
        conversationReader: createDurableConversationReader(env.CONVERSATIONS, retentionPolicy),
        getConnectionStatus: async (principal) => {
          const installation = await registry.getInstallation(principal.tenantId);
          return {
            provider: "meta_whatsapp_cloud_api",
            environment: "development",
            connected: installation?.status === "connected",
            appMode: "development",
            writeToolsRegistered: Boolean(runtimeMessaging && installation?.status === "connected")
          };
        },
        ...options,
        ...(runtimeMessaging ? { messaging: runtimeMessaging } : {}),
        ...(runtimeTokenVerifier ? { verifyToken: runtimeTokenVerifier } : {})
      });
      return handler.fetch(request);
    }
  };
}

// OAuth remains deny-all when no verifier is injected. This prevents a local
// persistence build from accidentally becoming a public data endpoint.
export default createPersistentWhatsAppWorker();
export { conversationRetentionPolicyFromEnv };

function hasPilotConfiguration(env: PersistentWhatsAppWorkerEnv): env is PersistentWhatsAppWorkerEnv & PilotOnboardingEnv {
  return [
    env.META_APP_ID,
    env.META_APP_SECRET,
    env.META_GRAPH_API_VERSION,
    env.META_EMBEDDED_SIGNUP_CONFIG_ID,
    env.META_WEBHOOK_VERIFY_TOKEN,
    env.INSTALLATION_ENCRYPTION_KEY,
    env.PILOT_ADMIN_TOKEN,
    env.PUBLIC_ORIGIN,
    env.CONVERSATION_REF_SECRET
  ].every((value) => typeof value === "string" && value.length > 0);
}

function hasOAuthConfiguration(env: PersistentWhatsAppWorkerEnv): env is PersistentWhatsAppWorkerEnv & {
  PUBLIC_ORIGIN: string;
  OAUTH_SIGNING_KEY_ID: string;
  OAUTH_SIGNING_PRIVATE_JWK: string;
  OAUTH_SIGNING_PUBLIC_JWK: string;
} {
  return Boolean(
    safePublicOrigin(env.PUBLIC_ORIGIN) &&
    env.OAUTH_SIGNING_KEY_ID?.trim() &&
    env.OAUTH_SIGNING_PRIVATE_JWK?.trim() &&
    env.OAUTH_SIGNING_PUBLIC_JWK?.trim()
  );
}

function parseSigningKey(env: PersistentWhatsAppWorkerEnv & {
  OAUTH_SIGNING_KEY_ID: string;
  OAUTH_SIGNING_PRIVATE_JWK: string;
  OAUTH_SIGNING_PUBLIC_JWK: string;
}) {
  const privateJwk = JSON.parse(env.OAUTH_SIGNING_PRIVATE_JWK) as JsonWebKey;
  const publicJwk = JSON.parse(env.OAUTH_SIGNING_PUBLIC_JWK) as JsonWebKey;
  if (privateJwk.kty !== "RSA" || publicJwk.kty !== "RSA" || !privateJwk.d || !publicJwk.n || !publicJwk.e) {
    throw new Error("OAuth signing keys are not a valid RSA JWK pair");
  }
  return { kid: env.OAUTH_SIGNING_KEY_ID, privateJwk, publicJwk };
}

function safePublicOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value.replace(/\/$/u, "") ? url.origin : null;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function noStoreHeaders(): Headers {
  return new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
}
