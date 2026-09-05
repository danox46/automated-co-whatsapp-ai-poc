export type WhatsAppMcpPrincipal = {
  subject: string;
  audience: string;
  scopes: ReadonlySet<string>;
  tokenId?: string;
};

export type WhatsAppMcpTokenVerifier = (
  bearerToken: string,
  request: Request
) => Promise<WhatsAppMcpPrincipal | null>;

export const REQUIRED_WHATSAPP_MCP_SCOPES = [
  "whatsapp.policy.read",
  "whatsapp.connection.read"
] as const;

export const SUPPORTED_WHATSAPP_MCP_SCOPES = [
  ...REQUIRED_WHATSAPP_MCP_SCOPES,
  "whatsapp.messages.send"
] as const;

export function hasWhatsAppMcpScopes(
  principal: WhatsAppMcpPrincipal,
  requiredScopes: readonly string[]
): boolean {
  return requiredScopes.every((scope) => principal.scopes.has(scope));
}

export function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return null;

  const match = authorization.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
}

export function authorizeWhatsAppMcpRequest(
  request: Request,
  expectedAudience: string,
  verifier: WhatsAppMcpTokenVerifier
) {
  return async (): Promise<WhatsAppMcpPrincipal | null> => {
    const token = readBearerToken(request);
    if (!token) return null;

    const principal = await verifier(token, request);
    if (!principal || principal.audience !== expectedAudience) return null;

    return principal;
  };
}

export const denyAllTokenVerifier: WhatsAppMcpTokenVerifier = async () => null;
