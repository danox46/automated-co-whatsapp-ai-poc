import type { AppConfig } from "../config/env.js";
import { createProtectedWhatsAppMcpHandler } from "./server.js";

export function createInternalMcpLocalRuntime(config: AppConfig) {
  const mcp = createProtectedWhatsAppMcpHandler({
    resource: config.mcp.resource,
    authorizationServer: config.mcp.authorizationServer
  });

  return {
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname === "/health") {
        return Response.json({
          ok: true,
          service: "automated-co-whatsapp-mcp",
          activeProvider: "internal_mcp",
          defaultProvider: "internal_mcp",
          transport: "streamable_http",
          oauthVerifierConfigured: false,
          conversationPersistenceConfigured: false,
          outboundMessagingConfigured: false,
          legacyTwilioEnabled: false
        }, {
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      return mcp.fetch(request);
    }
  };
}
