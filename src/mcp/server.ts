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
  hasWhatsAppMcpScopes,
  readBearerToken,
  SUPPORTED_WHATSAPP_MCP_SCOPES,
  type WhatsAppMcpPrincipal,
  type WhatsAppMcpTokenVerifier
} from "./auth.js";
import {
  dispatchApprovedTemplate,
  dispatchFreeFormReply,
  type WhatsAppMessagingCapability,
  type WhatsAppOutboundResult
} from "./outboundPolicy.js";
import {
  decodeCursor,
  MAX_CONVERSATION_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  type WhatsAppConversationReader
} from "./conversationHistory.js";

const POLICY_READ_SCOPE = "whatsapp.policy.read";
const CONNECTION_READ_SCOPE = "whatsapp.connection.read";
const CONVERSATION_READ_SCOPE = "whatsapp.conversations.read";
const MESSAGE_SEND_SCOPE = "whatsapp.messages.send";

type OAuth2SecurityScheme = {
  type: "oauth2";
  scopes: string[];
};

const TOOL_OAUTH_SCOPES: Readonly<Record<string, readonly string[]>> = {
  whatsapp_get_policy: [POLICY_READ_SCOPE],
  whatsapp_get_connection_status: [CONNECTION_READ_SCOPE],
  whatsapp_evaluate_action: [POLICY_READ_SCOPE],
  whatsapp_list_conversations: [CONVERSATION_READ_SCOPE],
  whatsapp_get_conversation_history: [CONVERSATION_READ_SCOPE],
  whatsapp_reply_to_inbound: [MESSAGE_SEND_SCOPE],
  whatsapp_send_template: [MESSAGE_SEND_SCOPE]
};

function oauthSecuritySchemes(scopes: readonly string[]): OAuth2SecurityScheme[] {
  return [{ type: "oauth2", scopes: [...scopes] }];
}

function oauthSecurityMetadata(scopes: readonly string[]) {
  const securitySchemes = oauthSecuritySchemes(scopes);
  return { securitySchemes };
}

function addTopLevelToolSecuritySchemes(payload: unknown): boolean {
  const messages = Array.isArray(payload) ? payload : [payload];
  let changed = false;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const result = (message as { result?: unknown }).result;
    if (!result || typeof result !== "object") continue;
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) continue;

    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      const namedTool = tool as { name?: unknown; securitySchemes?: OAuth2SecurityScheme[] };
      if (typeof namedTool.name !== "string") continue;
      const scopes = TOOL_OAUTH_SCOPES[namedTool.name];
      if (!scopes) continue;
      namedTool.securitySchemes = oauthSecuritySchemes(scopes);
      changed = true;
    }
  }

  return changed;
}

function replacedResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function advertiseTopLevelToolSecuritySchemes(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      return response;
    }

    return addTopLevelToolSecuritySchemes(payload)
      ? replacedResponse(response, JSON.stringify(payload))
      : response;
  }

  if (!contentType.includes("text/event-stream")) return response;
  const originalBody = await response.clone().text();
  let changed = false;
  const updatedBody = originalBody.split(/(?<=\n)/).map((line) => {
    const match = /^(data:\s*)(.*?)(\r?\n)?$/.exec(line);
    if (!match) return line;
    try {
      const payload = JSON.parse(match[2]) as unknown;
      if (!addTopLevelToolSecuritySchemes(payload)) return line;
      changed = true;
      return `${match[1]}${JSON.stringify(payload)}${match[3] ?? ""}`;
    } catch {
      return line;
    }
  }).join("");

  return changed ? replacedResponse(response, updatedBody) : response;
}

function isValidCursor(value: string): boolean {
  try {
    decodeCursor(value);
    return true;
  } catch {
    return false;
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export type WhatsAppConnectionStatus = {
  provider: "meta_whatsapp_cloud_api";
  environment: "not-configured" | "development" | "production";
  connected: boolean;
  appMode: "not-created" | "development" | "live";
  writeToolsRegistered: boolean;
};

export type CreateWhatsAppMcpHandlerOptions = {
  resource: string;
  authorizationServer: string;
  verifyToken?: WhatsAppMcpTokenVerifier;
  getConnectionStatus?: (principal: WhatsAppMcpPrincipal) => Promise<WhatsAppConnectionStatus>;
  conversationReader?: WhatsAppConversationReader;
  messaging?: WhatsAppMessagingCapability;
};

const actionSchema = z.enum([
  "read_policy",
  "read_connection_status",
  "read_conversations",
  "read_conversation_history",
  "reply_to_inbound",
  "start_conversation",
  "send_template",
  "bulk_send",
  "create_or_update_template",
  "change_webhook",
  "export_customer_data",
  "delete_customer_data"
]);

const connectionStatusOutputSchema = z.object({
  provider: z.literal("meta_whatsapp_cloud_api"),
  environment: z.enum(["not-configured", "development", "production"]),
  connected: z.boolean(),
  appMode: z.enum(["not-created", "development", "live"]),
  writeToolsRegistered: z.boolean()
});

const policyOutputSchema = z.object({
  version: z.string(),
  urls: z.object({
    overview: z.string().url(),
    privacy: z.string().url(),
    terms: z.string().url(),
    deletion: z.string().url(),
    support: z.string().url()
  }),
  mode: z.literal("capability-maximizing-policy-enforced"),
  retention: z.object({
    messageContentDays: z.number().int().positive(),
    inactiveConversationDays: z.number().int().positive(),
    unmatchedDeliveryStatusDays: z.number().int().positive(),
    pruneIntervalHours: z.number().int().positive(),
    optOutSuppression: z.literal("while_connection_active_or_until_authenticated_deletion")
  }),
  rules: z.array(z.string()),
  alwaysRegisteredTools: z.array(z.string()),
  conversationStoreBackedTools: z.array(z.string()),
  providerBackedTools: z.array(z.string()),
  runtimePolicyActions: z.array(z.string()),
  administrativeActionsNotExposed: z.array(z.string())
});

const actionDecisionOutputSchema = z.object({
  allowed: z.boolean().nullable(),
  action: actionSchema,
  status: z.enum(["allowed", "blocked", "runtime_check_required"]),
  code: z.string(),
  message: z.string(),
  reasons: z.array(z.string()),
  requiredNextStep: z.string().optional()
});

const protectionDecisionSchema = z.object({
  allowed: z.literal(false),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  protectedBy: z.enum(["whatsapp-business-policy", "mcp-authorization", "business-safety-policy"]),
  requiredAction: z.enum(["approved_template_required", "customer_message_required", "human_review_required"]).optional(),
  suggestedTool: z.literal("whatsapp_send_template").optional(),
  windowClosedAt: z.string().optional()
});

const outboundOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    messageRef: z.string(),
    status: z.enum(["accepted", "queued", "sent"])
  }),
  z.object({
    ok: z.literal(false),
    error: protectionDecisionSchema
  })
]);

const customerServiceWindowSchema = z.object({
  status: z.enum(["open", "closed", "unavailable"]),
  closesAt: z.string().optional()
});

const conversationSummarySchema = z.object({
  conversationRef: z.string(),
  displayName: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string(),
  lastVerifiedUserInboundAt: z.string().optional(),
  lastOutboundAt: z.string().optional(),
  messageCount: z.number().int().nonnegative(),
  unreadInboundCount: z.number().int().nonnegative(),
  recipientOptedOut: z.boolean(),
  automationPaused: z.boolean(),
  policyRevision: z.string(),
  customerServiceWindow: customerServiceWindowSchema
});

const conversationMessageSchema = z.object({
  messageRef: z.string(),
  conversationRef: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  kind: z.enum([
    "text", "template", "interactive", "image", "audio", "video",
    "document", "location", "contact", "sticker", "reaction", "unknown"
  ]),
  text: z.string().optional(),
  templateName: z.string().optional(),
  occurredAt: z.string(),
  status: z.enum(["received", "accepted", "sent", "delivered", "read", "failed"])
});

const conversationListOutputSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  nextCursor: z.string().optional()
});

const conversationHistoryOutputSchema = z.discriminatedUnion("found", [
  z.object({
    found: z.literal(true),
    conversation: conversationSummarySchema,
    messages: z.array(conversationMessageSchema),
    nextCursor: z.string().optional()
  }),
  z.object({
    found: z.literal(false),
    conversationRef: z.string(),
    error: z.object({
      code: z.literal("WHATSAPP_CONVERSATION_NOT_FOUND"),
      message: z.string()
    })
  })
]);

function textResult<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function structuredOnlyResult<T extends Record<string, unknown>>(value: T, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: value
  };
}

function outboundResult(value: WhatsAppOutboundResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(value.ok ? {} : { isError: true as const })
  };
}

function oauthErrorResult(
  resource: string,
  requiredScopes: readonly string[],
  reason: "invalid_token" | "insufficient_scope"
) {
  const metadataUrl = `${resource.replace(/\/$/, "")}/.well-known/oauth-protected-resource`;
  const description = reason === "invalid_token"
    ? "Connect your account to use this WhatsApp tool."
    : `Reconnect and approve the required scope: ${requiredScopes.join(" ")}.`;
  const challenge = [
    `Bearer resource_metadata="${metadataUrl}"`,
    `error="${reason}"`,
    `error_description="${description}"`,
    `scope="${requiredScopes.join(" ")}"`
  ].join(", ");

  return {
    content: [{ type: "text" as const, text: description }],
    structuredContent: {
      ok: false,
      error: {
        code: reason === "invalid_token" ? "MCP_AUTHENTICATION_REQUIRED" : "MCP_SCOPE_REQUIRED",
        message: description,
        requiredScopes: [...requiredScopes]
      }
    },
    _meta: { "mcp/www_authenticate": [challenge] },
    isError: true as const
  };
}

function toolAuthorizationError(
  principal: WhatsAppMcpPrincipal | null,
  resource: string,
  requiredScopes: readonly string[]
) {
  if (!principal) return oauthErrorResult(resource, requiredScopes, "invalid_token");
  if (!hasWhatsAppMcpScopes(principal, requiredScopes)) {
    return oauthErrorResult(resource, requiredScopes, "insufficient_scope");
  }
  return null;
}

function createWhatsAppPolicyServer(
  principal: WhatsAppMcpPrincipal | null,
  resource: string,
  getConnectionStatus: NonNullable<CreateWhatsAppMcpHandlerOptions["getConnectionStatus"]>,
  conversationReader?: WhatsAppConversationReader,
  messaging?: WhatsAppMessagingCapability
) {
  const server = new McpServer(
    {
      name: "automated-co-whatsapp-policy",
      version: "0.3.0"
    },
    {
      instructions: "Use connection status before messaging when readiness is unknown. Conversation tools return tenant-scoped structured records only; never infer records outside their result. Free-form replies require a server-verified 24-hour customer-service window. If it is closed, use only an approved template for a consented purpose. Never invent recipients, consent, timestamps, sender identity, or template approval."
    }
  );

  if (conversationReader) {
    const cursor = z.string()
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .refine(isValidCursor, "Invalid opaque cursor")
      .optional();

    server.registerTool(
      "whatsapp_list_conversations",
      {
        title: "List WhatsApp conversations",
        description: "Lists a bounded page of sanitized WhatsApp conversation summaries for the authenticated tenant. Returns structured data only and cannot modify messages or policy state.",
        inputSchema: z.strictObject({
          limit: z.number().int().min(1).max(MAX_CONVERSATION_PAGE_SIZE).default(20),
          cursor,
          updatedAfter: z.string()
            .refine(isCanonicalIsoTimestamp, "Expected a canonical UTC ISO timestamp")
            .optional()
        }),
        outputSchema: conversationListOutputSchema,
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false
        },
        _meta: oauthSecurityMetadata([CONVERSATION_READ_SCOPE])
      },
      async (input) => {
        const authError = toolAuthorizationError(principal, resource, [CONVERSATION_READ_SCOPE]);
        if (authError) return authError;
        const result = await conversationReader.listConversations(
          principal as WhatsAppMcpPrincipal,
          input
        );
        return structuredOnlyResult(result, "Structured conversation summaries are available in structuredContent.");
      }
    );

    server.registerTool(
      "whatsapp_get_conversation_history",
      {
        title: "Read WhatsApp conversation history",
        description: "Returns a bounded page of normalized message history and enforced policy state for one opaque conversation reference owned by the authenticated tenant. It never returns raw webhook payloads or changes state.",
        inputSchema: z.strictObject({
          conversationRef: z.string().trim().min(1).max(200),
          limit: z.number().int().min(1).max(MAX_MESSAGE_PAGE_SIZE).default(50),
          cursor
        }),
        outputSchema: conversationHistoryOutputSchema,
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false
        },
        _meta: oauthSecurityMetadata([CONVERSATION_READ_SCOPE])
      },
      async (input) => {
        const authError = toolAuthorizationError(principal, resource, [CONVERSATION_READ_SCOPE]);
        if (authError) return authError;
        const result = await conversationReader.getConversationHistory(
          principal as WhatsAppMcpPrincipal,
          input
        );
        if (!result) {
          const notFound = {
            found: false as const,
            conversationRef: input.conversationRef,
            error: {
              code: "WHATSAPP_CONVERSATION_NOT_FOUND" as const,
              message: "No conversation with that reference exists in the authenticated tenant."
            }
          };
          return { ...structuredOnlyResult(notFound, notFound.error.message), isError: true as const };
        }
        return structuredOnlyResult(
          { found: true as const, ...result },
          "Structured conversation history is available in structuredContent."
        );
      }
    );
  }

  server.registerTool(
    "whatsapp_get_policy",
    {
      title: "Read WhatsApp MCP policy",
      description: "Returns the public privacy, terms, consent, retention, and deny-by-default rules enforced by this MCP server.",
      inputSchema: z.object({}),
      outputSchema: policyOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      },
      _meta: oauthSecurityMetadata([POLICY_READ_SCOPE])
    },
    async () => {
      const authError = toolAuthorizationError(principal, resource, [POLICY_READ_SCOPE]);
      return authError ?? textResult(whatsappPublicPolicy);
    }
  );

  if (messaging) {
    const conversationRef = z.string().trim().min(1).max(200);
    const idempotencyKey = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

    server.registerTool(
      "whatsapp_reply_to_inbound",
      {
        title: "Reply to a WhatsApp customer",
        description: "Sends a free-form reply only while the server-verified 24-hour customer-service window is open. A closed window returns a protective error that directs the caller to an approved template.",
        inputSchema: z.strictObject({
          conversationRef,
          text: z.string().trim().min(1).max(4096),
          idempotencyKey
        }),
        outputSchema: outboundOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: messaging.guaranteesDurableIdempotency,
          openWorldHint: true
        },
        _meta: oauthSecurityMetadata([MESSAGE_SEND_SCOPE])
      },
      async (input) => {
        const authError = toolAuthorizationError(principal, resource, [MESSAGE_SEND_SCOPE]);
        return authError ?? outboundResult(await dispatchFreeFormReply(messaging, principal as WhatsAppMcpPrincipal, input));
      }
    );

    server.registerTool(
      "whatsapp_send_template",
      {
        title: "Send an approved WhatsApp template",
        description: "Starts or reopens a conversation using a server-verified approved template for a recipient-consented category.",
        inputSchema: z.strictObject({
          conversationRef,
          templateName: z.string().trim().min(1).max(512).regex(/^[a-z0-9_]+$/),
          variables: z.array(z.string().max(1024)).max(20).default([]),
          idempotencyKey
        }),
        outputSchema: outboundOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: messaging.guaranteesDurableIdempotency,
          openWorldHint: true
        },
        _meta: oauthSecurityMetadata([MESSAGE_SEND_SCOPE])
      },
      async (input) => {
        const authError = toolAuthorizationError(principal, resource, [MESSAGE_SEND_SCOPE]);
        return authError ?? outboundResult(await dispatchApprovedTemplate(messaging, principal as WhatsAppMcpPrincipal, input));
      }
    );
  }

  server.registerTool(
    "whatsapp_get_connection_status",
    {
      title: "Read WhatsApp connection status",
      description: "Returns sanitized provider readiness without identifiers, message data, tokens, or secrets.",
      inputSchema: z.object({}),
      outputSchema: connectionStatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      },
      _meta: oauthSecurityMetadata([CONNECTION_READ_SCOPE])
    },
    async () => {
      const authError = toolAuthorizationError(principal, resource, [CONNECTION_READ_SCOPE]);
      return authError ?? textResult(await getConnectionStatus(principal as WhatsAppMcpPrincipal));
    }
  );

  server.registerTool(
    "whatsapp_evaluate_action",
    {
      title: "Evaluate a WhatsApp action",
      description: "Evaluates the fixed server policy without performing the requested action. Messaging actions report whether a server-owned runtime check or a separate administrative workflow is required.",
      inputSchema: z.object({ action: actionSchema }),
      outputSchema: actionDecisionOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false
      },
      _meta: oauthSecurityMetadata([POLICY_READ_SCOPE])
    },
    async ({ action }) => {
      const authError = toolAuthorizationError(principal, resource, [POLICY_READ_SCOPE]);
      return authError ?? textResult(evaluateWhatsAppMcpAction(action as WhatsAppMcpAction));
    }
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
    writeToolsRegistered: Boolean(options.messaging)
  }));

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: options.resource,
          authorization_servers: [options.authorizationServer],
          scopes_supported: [...SUPPORTED_WHATSAPP_MCP_SCOPES],
          bearer_methods_supported: ["header"],
          resource_documentation: whatsappPublicPolicy.urls.overview,
          resource_policy_uri: whatsappPublicPolicy.urls.privacy,
          resource_tos_uri: whatsappPublicPolicy.urls.terms
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

      const principal = readBearerToken(request)
        ? await authorizeWhatsAppMcpRequest(request, options.resource, verifyToken)()
        : null;
      const handler = createMcpHandler(() => createWhatsAppPolicyServer(
        principal,
        options.resource,
        getConnectionStatus,
        options.conversationReader,
        options.messaging
      ));
      return advertiseTopLevelToolSecuritySchemes(await handler.fetch(request));
    }
  };
}
