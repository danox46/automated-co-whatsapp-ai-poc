import {
  createDurableConversationReader,
  createDurableConversationWriter,
  WhatsAppConversationDurableObject,
  type DurableConversationNamespace
} from "./durableConversationStore.js";
import {
  createProtectedWhatsAppMcpHandler,
  type CreateWhatsAppMcpHandlerOptions
} from "./server.js";
import {
  handleMetaWhatsAppWebhook,
  type MetaWebhookEnv
} from "../meta/webhook.js";

const RESOURCE = "https://auth.automatedandco.danienremoto.com";

export type PersistentWhatsAppWorkerEnv = MetaWebhookEnv & {
  CONVERSATIONS: DurableConversationNamespace;
  META_TENANT_ID: string;
  CONVERSATION_REF_SECRET: string;
};

export type PersistentWhatsAppWorkerOptions = Pick<
  CreateWhatsAppMcpHandlerOptions,
  "verifyToken" | "messaging"
>;

export { WhatsAppConversationDurableObject };

export function createPersistentWhatsAppWorker(
  options: PersistentWhatsAppWorkerOptions = {}
) {
  return {
    async fetch(request: Request, env: PersistentWhatsAppWorkerEnv): Promise<Response> {
      const writer = createDurableConversationWriter(env.CONVERSATIONS);
      const webhookResponse = await handleMetaWhatsAppWebhook(request, env, {
        tenantId: env.META_TENANT_ID,
        conversationRefSecret: env.CONVERSATION_REF_SECRET,
        writer
      });
      if (webhookResponse) return webhookResponse;

      if (new URL(request.url).pathname === "/health") {
        return Response.json({
          ok: true,
          conversationPersistence: "durable-object-sqlite",
          rawWebhookPayloadRetention: false,
          conversationReadTools: true,
          oauthVerifierConfigured: Boolean(options.verifyToken),
          outboundMessagingConfigured: Boolean(options.messaging)
        }, {
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      const handler = createProtectedWhatsAppMcpHandler({
        resource: RESOURCE,
        authorizationServer: RESOURCE,
        conversationReader: createDurableConversationReader(env.CONVERSATIONS),
        getConnectionStatus: async () => ({
          provider: "meta_whatsapp_cloud_api",
          environment: "development",
          connected: false,
          appMode: "development",
          writeToolsRegistered: Boolean(options.messaging)
        }),
        ...options
      });
      return handler.fetch(request);
    }
  };
}

// OAuth remains deny-all when no verifier is injected. This prevents a local
// persistence build from accidentally becoming a public data endpoint.
export default createPersistentWhatsAppWorker();
