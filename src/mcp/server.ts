import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  evaluateWhatsAppMcpAction,
  whatsappPublicPolicy,
  type WhatsAppMcpAction
} from "./whatsappPolicy.js";
import {
  authorizeWhatsAppMcpRequest,
  denyAllTokenVerifier,
  REQUIRED_WHATSAPP_MCP_SCOPES,
  type WhatsAppMcpPrincipal,
  type WhatsAppMcpTokenVerifier
} from "./auth.js";

export type WhatsAppConnectionStatus = {
  provider: "meta_whatsapp_cloud_api";
  environment: "not-configured" | "development" | "production";
  connected: boolean;
  appMode: "not-created" | "development" | "live";
  writeToolsRegistered: false;
};

export type CreateWhatsAppMcpHandlerOptions = {
  resource: string;
  authorizationServer: string;
  verifyToken?: WhatsAppMcpTokenVerifier;
  getConnectionStatus?: (principal: WhatsAppMcpPrincipal) => Promise<WhatsAppConnectionStatus>;
};

const actionSchema = z.enum([
  "read_policy",
  "read_connection_status",
  "reply_to_inbound",
  "start_conversation",
  "send_template",
  "bulk_send",
  "create_or_update_template",
  "change_webhook",
  "export_customer_data",
  "delete_customer_data"
]);

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

function createWhatsAppPolicyServer(
  principal: WhatsAppMcpPrincipal,
  getConnectionStatus: NonNullable<CreateWhatsAppMcpHandlerOptions["getConnectionStatus"]>
) {
  const server = new McpServer({
    name: "automated-co-whatsapp-policy",
    version: "0.1.0"
  });

  server.registerTool(
    "whatsapp_get_policy",
    {
      title: "Read WhatsApp MCP policy",
      description: "Returns the public privacy, terms, consent, retention, and deny-by-default rules enforced by this MCP server.",
      inputSchema: z.object({})
    },
    async () => textResult(whatsappPublicPolicy)
  );

  server.registerTool(
    "whatsapp_get_connection_status",
    {
      title: "Read WhatsApp connection status",
      description: "Returns sanitized provider readiness without identifiers, message data, tokens, or secrets.",
      inputSchema: z.object({})
    },
    async () => textResult(await getConnectionStatus(principal))
  );

  server.registerTool(
    "whatsapp_evaluate_action",
    {
      title: "Evaluate a WhatsApp action",
      description: "Evaluates the fixed server policy. It never performs the requested action and all WhatsApp writes are denied in this release.",
      inputSchema: z.object({ action: actionSchema })
    },
    async ({ action }) => textResult(evaluateWhatsAppMcpAction(action as WhatsAppMcpAction))
  );

  return server;
}

export function createProtectedWhatsAppMcpHandler(options: CreateWhatsAppMcpHandlerOptions) {
  const verifyToken = options.verifyToken ?? denyAllTokenVerifier;
  const getConnectionStatus = options.getConnectionStatus ?? (async () => ({
    provider: "meta_whatsapp_cloud_api" as const,
    environment: "not-configured" as const,
    connected: false,
    appMode: "not-created" as const,
    writeToolsRegistered: false as const
  }));

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: options.resource,
          authorization_servers: [options.authorizationServer],
          scopes_supported: [...REQUIRED_WHATSAPP_MCP_SCOPES],
          bearer_methods_supported: ["header"]
        }, {
          headers: {
            "Cache-Control": "public, max-age=300"
          }
        });
      }

      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      if (url.searchParams.has("access_token") || url.searchParams.has("token")) {
        return new Response("Tokens in URLs are forbidden", { status: 400 });
      }

      const principal = await authorizeWhatsAppMcpRequest(
        request,
        options.resource,
        verifyToken
      )();

      if (!principal) {
        const metadataUrl = `${options.resource.replace(/\/$/, "")}/.well-known/oauth-protected-resource`;
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
            "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`
          }
        });
      }

      const handler = createMcpHandler(() => createWhatsAppPolicyServer(principal, getConnectionStatus));
      return handler.fetch(request);
    }
  };
}
