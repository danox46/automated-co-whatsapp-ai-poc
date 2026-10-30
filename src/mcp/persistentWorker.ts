import { persistMetaAccountUpdates } from "../meta/accountUpdates.js";
import {createCustomerRuntime} from '../meta/customerRuntime.js';
import {
  createDurableConversationReader,
  createDurableAttachmentContentReader,
  createDurableAttachmentContentStore,
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
import { createMetaAttachmentCapture } from "../meta/attachmentCapture.js";
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
import { decryptPilotSecret } from "../meta/pilotCrypto.js";
import { createSandboxBotBridge } from "../meta/sandboxBotBridge.js";
import { createSandboxFlowAdmin } from "../meta/sandboxFlowAdmin.js";
import { createSandboxFlowMessaging } from "../meta/sandboxFlowMessaging.js";
import { opaqueConversationRef } from "../meta/conversationEvents.js";
import { opaqueInstallationRef } from "../meta/installationIdentity.js";
import { nativeBotOAuthClient, NATIVE_WHATSAPP_BOT_CLIENT_ID } from "../oauth/nativeBotClient.js";
import { MorningOperatorSessions } from '../oauth/morningSessions.js';
import {
  readWhatsAppSandboxConfig,
  sandboxRecipientAllowed,
  type WhatsAppSandboxConfig,
  type WhatsAppSandboxEnv
} from "../meta/sandboxConfig.js";

export type PersistentWhatsAppWorkerEnv = MetaWebhookEnv & WhatsAppSandboxEnv & {
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
  SANDBOX_BOT_BRIDGE_TOKEN?: string;
  META_SANDBOX_VISIT_FLOW_ID?: string;
  META_SANDBOX_WHOLESALE_FLOW_ID?: string;
  PUBLIC_ORIGIN?: string;
  OAUTH_SIGNING_KEY_ID?: string;
  OAUTH_SIGNING_PRIVATE_JWK?: string;
  OAUTH_SIGNING_PUBLIC_JWK?: string;
  OAUTH_CLIENT_ID?: string;
  OAUTH_REDIRECT_URI?: string;
  BOT_OAUTH_REDIRECT_URI?: string;
  MORNING_ISSUER?: string;
  MORNING_CLIENT_ID?: string;
  MORNING_CUSTOMER_CLIENT_ID?: string;
  MORNING_OPERATOR_BINDINGS?: string;
  CONVERSATION_MESSAGE_RETENTION_DAYS?: string;
  CONVERSATION_INACTIVE_RETENTION_DAYS?: string;
  CONVERSATION_PENDING_STATUS_RETENTION_DAYS?: string;
  CONVERSATION_RETENTION_INTERVAL_HOURS?: string;
};

export type PersistentWhatsAppWorkerOptions = Pick<
  CreateWhatsAppMcpHandlerOptions,
  "verifyToken" | "messaging"
> & { morningRequest?: NonNullable<ConstructorParameters<typeof MorningOperatorSessions>[0]['request']> };

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
      let sandboxConfigurationValid = true;
      let sandbox: WhatsAppSandboxConfig | null = null;
      try {
        sandbox = readWhatsAppSandboxConfig(env);
      } catch {
        sandboxConfigurationValid = false;
      }
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
        policyDirectory: createDurableWhatsAppPolicyDirectory(env.CONVERSATIONS),
        recipientAllowed: (tenantId, recipient) => {
          const configuredSandboxTenant = env.META_SANDBOX_TENANT_ID;
          if (configuredSandboxTenant && tenantId === configuredSandboxTenant) {
            return sandboxConfigurationValid && sandboxRecipientAllowed(sandbox, tenantId, recipient);
          }
          return true;
        }
      }) : undefined);
      const flowMessaging = sandbox && graph && (env.META_SANDBOX_VISIT_FLOW_ID || env.META_SANDBOX_WHOLESALE_FLOW_ID) ? createSandboxFlowMessaging({
        sandbox, graph, registry, conversations: env.CONVERSATIONS,
        flowIds: { visit: env.META_SANDBOX_VISIT_FLOW_ID, wholesale: env.META_SANDBOX_WHOLESALE_FLOW_ID },
        encryptionKey: env.INSTALLATION_ENCRYPTION_KEY as string, correlationSecret: env.CONVERSATION_REF_SECRET
      }) : undefined;
      const attachmentReader = createDurableAttachmentContentReader(env.CONVERSATIONS);
      const attachmentCapture = graph ? createMetaAttachmentCapture({
        registry,
        graph,
        encryptionKey: env.INSTALLATION_ENCRYPTION_KEY as string,
        contentStore: createDurableAttachmentContentStore(env.CONVERSATIONS),
        writer
      }) : undefined;

      const sandboxBotResponse = await createSandboxBotBridge({
        token: env.SANDBOX_BOT_BRIDGE_TOKEN,
        sandbox: sandboxConfigurationValid ? sandbox : null,
        conversations: env.CONVERSATIONS,
        messaging: runtimeMessaging,
        flowMessaging,
        listFlows: sandbox && graph ? async () => {
          const installation = await registry.getInstallation(sandbox.tenantId);
          if (!installation || installation.status !== "connected" || installation.wabaId !== sandbox.wabaId) {
            throw new Error("SANDBOX_INSTALLATION_NOT_CONNECTED");
          }
          const accessToken = await decryptPilotSecret(installation.encryptedAccessToken, env.INSTALLATION_ENCRYPTION_KEY as string);
          return graph.listFlows(accessToken, sandbox.wabaId);
        } : undefined,
        resource: safePublicOrigin(env.PUBLIC_ORIGIN) ?? ""
      })(request);
      if (sandboxBotResponse) return sandboxBotResponse;

      let runtimeTokenVerifier = options.verifyToken;
      let resource = safePublicOrigin(env.PUBLIC_ORIGIN);
      if (oauthConfigured && resource) {
        const signingKey = parseSigningKey(env);
        const nativeClient = nativeBotOAuthClient(env.BOT_OAUTH_REDIRECT_URI);
        if (nativeClient?.clientId === env.OAUTH_CLIENT_ID) throw new Error("Native and ChatGPT OAuth registrations must remain distinct");
        let morning: MorningOperatorSessions | undefined;
        const requestedWorkspace=new URL(request.url).searchParams.has('workspace_id');
        const customerRoute=requestedWorkspace || pathname.startsWith('/premium/auth/') || pathname==='/premium/whatsapp/setup';
        if(customerRoute && (!env.MORNING_CUSTOMER_CLIENT_ID || !env.MORNING_ISSUER || !env.INSTALLATION_ENCRYPTION_KEY || env.MORNING_CUSTOMER_CLIENT_ID===env.MORNING_CLIENT_ID)) {
          return Response.json({error:'customer_connection_unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});
        }
        if(pathname==='/premium/whatsapp/setup' && !pilotConfigured)return Response.json({error:'customer_connection_unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});
        if(customerRoute) {
          morning = new MorningOperatorSessions({origin:resource,issuer:env.MORNING_ISSUER!,clientId:env.MORNING_CUSTOMER_CLIENT_ID!,
            workspacePolicy:'enrolled-owner',encryptionKey:env.INSTALLATION_ENCRYPTION_KEY!,store:oauthState.morningStore,request:options.morningRequest,
            ...(pilotConfigured ? {customerSetup:{
              nativeRedirectUri:nativeClient?.redirectUris[0],
              status:async(tenantId:string)=>{const value=await registry.getInstallation(tenantId);return {connected:value?.status==='connected',...(value?.verifiedName?{name:value.verifiedName}:{}),...(value?.displayPhoneNumber?{number:value.displayPhoneNumber}:{})};},
              begin:async(input:{tenantId:string;workspaceId:string;token:string;createdAt:string;expiresAt:string})=>{
                const token=await registry.createInvite({tenantId:input.tenantId,label:'WhatsApp',cohortRole:'client',expiresAt:input.expiresAt,customerWorkspaceId:input.workspaceId},new Date(),{token:input.token,createdAt:input.createdAt});
                return resource+'/pilot/whatsapp/connect?invite='+encodeURIComponent(token);
              }
            }}:{}),
            installationConnected:async tenantId=>(await registry.getInstallation(tenantId))?.status==='connected',
            installationReference:async tenantId=>{
              const installation=await registry.getInstallation(tenantId);
              return installation?.status==='connected' ? opaqueInstallationRef(tenantId,installation.wabaId,installation.phoneNumberId,env.CONVERSATION_REF_SECRET) : null;
            }});
          const loginResponse=await morning.handle(request); if(loginResponse) return loginResponse;
        }
        if (!customerRoute && env.MORNING_ISSUER && env.MORNING_CLIENT_ID && env.MORNING_OPERATOR_BINDINGS && env.INSTALLATION_ENCRYPTION_KEY) {
          // The resolver closes over this request's Durable Object stubs and
          // installation registry. Never cache request-owned I/O across fetches.
          morning = new MorningOperatorSessions({ origin: resource, issuer: env.MORNING_ISSUER, clientId: env.MORNING_CLIENT_ID,
              encryptionKey: env.INSTALLATION_ENCRYPTION_KEY, bindings: JSON.parse(env.MORNING_OPERATOR_BINDINGS), store: oauthState.morningStore,
              request: options.morningRequest,
              installationConnected: async tenantId => (await registry.getInstallation(tenantId))?.status === 'connected',
              installationReference: async tenantId => {
                const installation = await registry.getInstallation(tenantId);
                return installation?.status === 'connected' ? opaqueInstallationRef(tenantId, installation.wabaId, installation.phoneNumberId, env.CONVERSATION_REF_SECRET) : null;
              } });
          const loginResponse = await morning.handle(request);
          if (loginResponse) return loginResponse;
        }
        const authorizationServer = createWhatsAppAuthorizationServer({
          issuer: resource,
          resource,
          signingKey,
          clients: createStaticOAuthClientRegistry([{
            clientId: env.OAUTH_CLIENT_ID ?? "https://chatgpt.com/oauth/client.json",
            redirectUris: [env.OAUTH_REDIRECT_URI ?? "https://chatgpt.com/connector_platform_oauth_redirect"]
          }, ...(nativeClient ? [nativeClient] : [])]),
          store: oauthState.store,
          resolveSession: async (authorizationRequest) => {
            if(customerRoute) return morning!.resolve(authorizationRequest);
            if (morning && new URL(authorizationRequest.url).searchParams.get('client_id') === NATIVE_WHATSAPP_BOT_CLIENT_ID) return morning.resolve(authorizationRequest);
            const rawSession = readCookie(authorizationRequest, PILOT_SESSION_COOKIE);
            // Preserve an existing business's Embedded Signup session. Once it
            // expires, the same registered cloud client can use Morning's
            // explicit operator assignments instead of repeating Meta signup.
            const pilotSession = rawSession ? await oauthState.resolvePilotSession(rawSession) : null;
            return pilotSession ?? (morning ? morning.resolve(authorizationRequest) : null);
          },
          // The authorization server validates the registered client, exact
          // redirect, resource, scopes and PKCE before requesting sign-in.
          onSessionRequired: morning ? authorizationRequest => morning!.start(authorizationRequest) : undefined,
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
        const flowAdminResponse = await createSandboxFlowAdmin({
          adminToken: env.PILOT_ADMIN_TOKEN,
          wabaId: sandboxConfigurationValid ? sandbox?.wabaId : undefined,
          graph: graph ?? undefined,
          accessToken: async () => {
            if (!sandbox) throw new Error("SANDBOX_NOT_CONFIGURED");
            const installation = await registry.getInstallation(sandbox.tenantId);
            if (!installation || installation.status !== "connected" || installation.wabaId !== sandbox.wabaId) {
              throw new Error("SANDBOX_INSTALLATION_NOT_CONNECTED");
            }
            return decryptPilotSecret(installation.encryptedAccessToken, env.INSTALLATION_ENCRYPTION_KEY as string);
          }
        })(request);
        if (flowAdminResponse) return flowAdminResponse;
        const pilot = createPilotOnboardingHandler(env as PersistentWhatsAppWorkerEnv & PilotOnboardingEnv, {
          registry,
          graph: graph as ReturnType<typeof createMetaGraphClient>,
          deleteConversationData: async (tenantId) =>
            createDurableConversationRetentionController(env.CONVERSATIONS)
              .deleteAllConversationData(tenantId),
          createAuthorizationSession: oauthState.createPilotSession,
          revokeAuthorizationSessions: oauthState.revokeTenant,
          ...(sandbox ? {
            sandbox,
            registerSandboxRecipients: async (tenantId, phoneNumberId, recipients, registeredAt) => {
              const stub = env.CONVERSATIONS.getByName(tenantId);
              await stub.initializeTenant(tenantId);
              let index = 0;
              for (const recipient of recipients) {
                index += 1;
                await stub.registerConversation({
                  conversationRef: await opaqueConversationRef(
                    tenantId,
                    phoneNumberId,
                    recipient,
                    env.CONVERSATION_REF_SECRET
                  ),
                  providerAccountRef: phoneNumberId,
                  providerParticipantRef: recipient,
                  displayName: `Approved sandbox recipient ${index}`,
                  registeredAt: registeredAt.toISOString()
                });
              }
            }
          } : {})
        });
        const policyAdmin = createWhatsAppPolicyAdminHandler({
          adminToken: env.PILOT_ADMIN_TOKEN as string,
          conversations: env.CONVERSATIONS,
          registry,
          graph: graph as ReturnType<typeof createMetaGraphClient>,
          encryptionKey: env.INSTALLATION_ENCRYPTION_KEY as string,
          ...(attachmentCapture ? { captureAttachment: attachmentCapture } : {})
        });
        const policyResponse = await policyAdmin.fetch(request);
        if (policyResponse) return policyResponse;
        const response = await pilot.fetch(request);
        if (response) return response;
      }

      const customerRuntime=createCustomerRuntime({conversations:env.CONVERSATIONS,registry,resource:resource??'https://unconfigured.invalid',secret:env.CONVERSATION_REF_SECRET,verifyToken:runtimeTokenVerifier,messaging:runtimeMessaging});
      const customerRuntimeResponse=await customerRuntime.fetch(request);if(customerRuntimeResponse)return customerRuntimeResponse;
      const webhookResponse = await handleMetaWhatsAppWebhook(request, env, async (payload) => {
        // account_update can use a partner portfolio as entry.id. Only message
        // entries participate in conversation routing, even in mixed batches.
        const wabaIds = metaWebhookWabaIds(payload, "messages");
        if (wabaIds.length !== 1) return null;
        const tenantId = await registry.resolveTenantForWaba(wabaIds[0]);
        return tenantId ? {
          tenantId,
          conversationRefSecret: env.CONVERSATION_REF_SECRET,
          writer,
          afterInbound:customerRuntime.inbound,
          ...(attachmentCapture ? { captureAttachment: attachmentCapture } : {})
        } : null;
      }, payload => persistMetaAccountUpdates(payload, env.META_APP_ID ?? "", update => registry.recordAccountUpdate(update)));
      if (webhookResponse) return webhookResponse;

      if (new URL(request.url).pathname === "/health") {
        return Response.json({
          ok: true,
          conversationPersistence: "durable-object-sqlite",
          rawWebhookPayloadRetention: false,
          retention: retentionPolicy,
          conversationReadTools: true,
          inboundImageCapture: Boolean(attachmentCapture),
          attachmentReadTool: Boolean(attachmentReader),
          pilotOnboardingConfigured: pilotConfigured,
          sandboxConfigured: Boolean(sandbox),
          sandboxConfigurationValid,
          sandboxRecipientRestriction: sandbox ? "server-allowlist" : "not-configured",
          sandboxBotBridgeConfigured: Boolean(sandbox && env.SANDBOX_BOT_BRIDGE_TOKEN && runtimeMessaging),
          draftFlowTestingConfigured: Boolean(flowMessaging),
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
        attachmentReader,
        flowMessaging,
        getConnectionStatus: async (principal) => {
          const installation = await registry.getInstallation(principal.tenantId);
          return {
            provider: "meta_whatsapp_cloud_api",
            environment: "development",
            connected: installation?.status === "connected",
            appMode: "development",
            writeToolsRegistered: Boolean(runtimeMessaging && installation?.status === "connected"),
            ...(installation?.status === "connected" ? { installationRef: await opaqueInstallationRef(
              principal.tenantId, installation.wabaId, installation.phoneNumberId, env.CONVERSATION_REF_SECRET
            ) } : {})
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
