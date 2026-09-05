import { SUPPORTED_WHATSAPP_MCP_SCOPES } from "../mcp/auth.js";
import {
  base64UrlEncodeBytes,
  decodeJwtPart,
  sha256Base64Url,
  signRs256Jwt,
  verifyRs256Jwt,
  type JsonObject
} from "./jwt.js";

const OIDC_SCOPES = ["openid", "email"] as const;

export type OAuthClient = {
  clientId: string;
  redirectUris: readonly string[];
};

export type OAuthClientRegistry = {
  resolve(clientId: string): Promise<OAuthClient | null>;
};

export type OAuthAuthorizedSession = {
  subject: string;
  tenantId: string;
  email?: string;
  emailVerified?: boolean;
  approvedScopes: ReadonlySet<string>;
};

type AuthorizationCodeRecord = OAuthAuthorizedSession & {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  nonce?: string;
  expiresAt: number;
};

type RefreshTokenRecord = OAuthAuthorizedSession & {
  tokenHash: string;
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
};

export type OAuthAuthorizationStore = {
  saveAuthorizationCode(record: AuthorizationCodeRecord): Promise<void>;
  consumeAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | null>;
  saveRefreshToken(record: RefreshTokenRecord): Promise<void>;
  consumeRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null>;
  revokeRefreshToken(tokenHash: string): Promise<void>;
  revokeAccessToken(tokenId: string, expiresAt: number): Promise<void>;
  isAccessTokenRevoked(tokenId: string): Promise<boolean>;
};

export class InMemoryOAuthAuthorizationStore implements OAuthAuthorizationStore {
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly revokedAccessTokens = new Map<string, number>();

  async saveAuthorizationCode(record: AuthorizationCodeRecord): Promise<void> {
    this.codes.set(record.codeHash, structuredClone(record));
  }

  async consumeAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | null> {
    const record = this.codes.get(codeHash);
    this.codes.delete(codeHash);
    return record ? structuredClone(record) : null;
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(record.tokenHash, structuredClone(record));
  }

  async consumeRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const record = this.refreshTokens.get(tokenHash);
    this.refreshTokens.delete(tokenHash);
    return record ? structuredClone(record) : null;
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    this.refreshTokens.delete(tokenHash);
  }

  async revokeAccessToken(tokenId: string, expiresAt: number): Promise<void> {
    this.revokedAccessTokens.set(tokenId, expiresAt);
  }

  async isAccessTokenRevoked(tokenId: string): Promise<boolean> {
    return this.revokedAccessTokens.has(tokenId);
  }
}

export type WhatsAppAuthorizationServerOptions = {
  issuer: string;
  resource: string;
  signingKey: {
    kid: string;
    privateJwk: JsonWebKey;
    publicJwk: JsonWebKey;
  };
  clients: OAuthClientRegistry;
  store: OAuthAuthorizationStore;
  resolveSession: (request: Request) => Promise<OAuthAuthorizedSession | null>;
  now?: () => Date;
  authorizationCodeTtlSeconds?: number;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  clientIdMetadataDocumentSupported?: boolean;
};

export function createWhatsAppAuthorizationServer(options: WhatsAppAuthorizationServerOptions) {
  const issuer = withoutTrailingSlash(options.issuer);
  const resource = withoutTrailingSlash(options.resource);
  const allowedScopes = new Set<string>([...OIDC_SCOPES, ...SUPPORTED_WHATSAPP_MCP_SCOPES]);
  const nowSeconds = () => Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const codeTtl = options.authorizationCodeTtlSeconds ?? 300;
  const accessTtl = options.accessTokenTtlSeconds ?? 600;
  const refreshTtl = options.refreshTokenTtlSeconds ?? 30 * 24 * 60 * 60;

  async function verifyIssuedAccessToken(token: string): Promise<JsonObject | null> {
    const verified = await verifyRs256Jwt(token, async (header) =>
      header.kid === options.signingKey.kid ? options.signingKey.publicJwk : null
    );
    if (!verified) return null;
    const claims = verified.claims;
    const current = nowSeconds();
    if (claims.iss !== issuer || !audienceIncludes(claims.aud, resource)) return null;
    if (typeof claims.exp !== "number" || claims.exp <= current) return null;
    if (typeof claims.nbf === "number" && claims.nbf > current + 30) return null;
    if (typeof claims.jti !== "string" || await options.store.isAccessTokenRevoked(claims.jti)) return null;
    return claims;
  }

  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/oauth-authorization-server" ||
          url.pathname === "/.well-known/openid-configuration") {
        return jsonResponse({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          revocation_endpoint: `${issuer}/oauth/revoke`,
          userinfo_endpoint: `${issuer}/oauth/userinfo`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: options.clientIdMetadataDocumentSupported === true,
          authorization_response_iss_parameter_supported: true,
          scopes_supported: [...OIDC_SCOPES, ...SUPPORTED_WHATSAPP_MCP_SCOPES],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"]
        }, 200, "public, max-age=300");
      }

      if (url.pathname === "/.well-known/jwks.json") {
        return jsonResponse({ keys: [publicSigningJwk(options.signingKey.publicJwk, options.signingKey.kid)] }, 200, "public, max-age=300");
      }

      if (url.pathname === "/oauth/authorize" && request.method === "GET") {
        return authorize(request);
      }
      if (url.pathname === "/oauth/token" && request.method === "POST") {
        return token(request);
      }
      if (url.pathname === "/oauth/revoke" && request.method === "POST") {
        return revoke(request);
      }
      if (url.pathname === "/oauth/userinfo" && request.method === "GET") {
        return userInfo(request);
      }
      return null;
    },
    verifyIssuedAccessToken
  };

  async function authorize(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const client = await options.clients.resolve(clientId);
    if (!client || client.clientId !== clientId || !client.redirectUris.includes(redirectUri)) {
      return oauthError("invalid_request", "Unknown client or redirect URI.");
    }

    const responseType = url.searchParams.get("response_type");
    const resourceParameter = url.searchParams.get("resource");
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const challengeMethod = url.searchParams.get("code_challenge_method");
    const state = url.searchParams.get("state") ?? "";
    const nonce = url.searchParams.get("nonce") ?? undefined;
    const scopes = parseScopes(url.searchParams.get("scope") ?? "");
    if (responseType !== "code" || resourceParameter !== resource || challengeMethod !== "S256" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge) || !state || !validScopes(scopes, allowedScopes)) {
      return redirectOAuthError(redirectUri, state, issuer, "invalid_request", "Invalid OAuth authorization request.");
    }

    const session = await options.resolveSession(request);
    if (!session) {
      return oauthError("login_required", "Sign in to Automated & CO before authorizing this connection.", 401);
    }
    if (!session.subject.trim() || !session.tenantId.trim() ||
        !scopes.every((scope) => session.approvedScopes.has(scope))) {
      return oauthError("consent_required", "The requested scopes have not been approved for this session.", 403);
    }
    if (scopes.includes("email") && (!session.email || session.emailVerified !== true)) {
      return oauthError("invalid_request", "A verified email is required for the email scope.", 403);
    }

    const rawCode = randomToken();
    await options.store.saveAuthorizationCode({
      ...session,
      codeHash: await sha256Base64Url(rawCode),
      clientId,
      redirectUri,
      resource,
      scopes,
      codeChallenge,
      ...(nonce ? { nonce } : {}),
      expiresAt: nowSeconds() + codeTtl
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", rawCode);
    redirect.searchParams.set("state", state);
    redirect.searchParams.set("iss", issuer);
    return new Response(null, { status: 302, headers: noStoreHeaders({ Location: redirect.toString() }) });
  }

  async function token(request: Request): Promise<Response> {
    const form = await readForm(request);
    if (!form) return oauthError("invalid_request", "Expected a bounded form-encoded token request.");
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") return exchangeAuthorizationCode(form);
    if (grantType === "refresh_token") return exchangeRefreshToken(form);
    return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  }

  async function exchangeAuthorizationCode(form: URLSearchParams): Promise<Response> {
    const rawCode = form.get("code") ?? "";
    const record = rawCode
      ? await options.store.consumeAuthorizationCode(await sha256Base64Url(rawCode))
      : null;
    if (!record) return oauthError("invalid_grant", "Authorization code is invalid or already used.");
    const current = nowSeconds();
    const verifier = form.get("code_verifier") ?? "";
    if (record.expiresAt <= current || form.get("client_id") !== record.clientId ||
        form.get("redirect_uri") !== record.redirectUri || form.get("resource") !== record.resource ||
        !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) || await sha256Base64Url(verifier) !== record.codeChallenge) {
      return oauthError("invalid_grant", "Authorization code binding or PKCE verification failed.");
    }
    return issueTokens(record, record.clientId, record.resource, record.scopes, record.nonce);
  }

  async function exchangeRefreshToken(form: URLSearchParams): Promise<Response> {
    const rawRefreshToken = form.get("refresh_token") ?? "";
    const record = rawRefreshToken
      ? await options.store.consumeRefreshToken(await sha256Base64Url(rawRefreshToken))
      : null;
    if (!record || record.expiresAt <= nowSeconds() || form.get("client_id") !== record.clientId ||
        form.get("resource") !== record.resource) {
      return oauthError("invalid_grant", "Refresh token is invalid, expired, or already used.");
    }
    const requestedScopes = form.has("scope") ? parseScopes(form.get("scope") ?? "") : record.scopes;
    if (!validScopes(requestedScopes, allowedScopes) || !requestedScopes.every((scope) => record.scopes.includes(scope))) {
      return oauthError("invalid_scope", "Refresh requests may only narrow previously granted scopes.");
    }
    return issueTokens(record, record.clientId, record.resource, requestedScopes);
  }

  async function issueTokens(
    identity: OAuthAuthorizedSession,
    clientId: string,
    tokenResource: string,
    scopes: string[],
    nonce?: string
  ): Promise<Response> {
    const current = nowSeconds();
    const tokenId = randomToken(18);
    const accessToken = await signRs256Jwt(
      { alg: "RS256", kid: options.signingKey.kid, typ: "at+jwt" },
      {
        iss: issuer,
        aud: tokenResource,
        sub: identity.subject,
        tenant_id: identity.tenantId,
        scope: scopes.join(" "),
        iat: current,
        nbf: current,
        exp: current + accessTtl,
        jti: tokenId,
        ...(identity.email ? { email: identity.email, email_verified: identity.emailVerified === true } : {})
      },
      options.signingKey.privateJwk
    );
    const rawRefreshToken = randomToken();
    await options.store.saveRefreshToken({
      ...identity,
      tokenHash: await sha256Base64Url(rawRefreshToken),
      clientId,
      resource: tokenResource,
      scopes,
      expiresAt: current + refreshTtl
    });

    const response: Record<string, unknown> = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: accessTtl,
      refresh_token: rawRefreshToken,
      scope: scopes.join(" ")
    };
    if (scopes.includes("openid")) {
      response.id_token = await signRs256Jwt(
        { alg: "RS256", kid: options.signingKey.kid, typ: "JWT" },
        {
          iss: issuer,
          aud: clientId,
          sub: identity.subject,
          iat: current,
          exp: current + accessTtl,
          ...(nonce ? { nonce } : {}),
          ...(identity.email ? { email: identity.email, email_verified: identity.emailVerified === true } : {})
        },
        options.signingKey.privateJwk
      );
    }
    return jsonResponse(response, 200, "no-store", true);
  }

  async function revoke(request: Request): Promise<Response> {
    const form = await readForm(request);
    const rawToken = form?.get("token") ?? "";
    if (!rawToken) return new Response(null, { status: 200, headers: noStoreHeaders() });
    if (rawToken.includes(".")) {
      const claims = await verifyIssuedAccessToken(rawToken);
      if (claims && typeof claims.jti === "string" && typeof claims.exp === "number") {
        await options.store.revokeAccessToken(claims.jti, claims.exp);
      }
    } else {
      await options.store.revokeRefreshToken(await sha256Base64Url(rawToken));
    }
    return new Response(null, { status: 200, headers: noStoreHeaders() });
  }

  async function userInfo(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/u.exec(authorization);
    const claims = match ? await verifyIssuedAccessToken(match[1]) : null;
    const scopes = claims && typeof claims.scope === "string" ? parseScopes(claims.scope) : [];
    if (!claims || !scopes.includes("openid")) {
      return oauthError("invalid_token", "A valid OpenID access token is required.", 401);
    }
    return jsonResponse({
      sub: claims.sub,
      ...(scopes.includes("email") && typeof claims.email === "string"
        ? { email: claims.email, email_verified: claims.email_verified === true }
        : {})
    }, 200, "no-store", true);
  }
}

export function createStaticOAuthClientRegistry(clients: readonly OAuthClient[]): OAuthClientRegistry {
  const byId = new Map(clients.map((client) => [client.clientId, client]));
  return { resolve: async (clientId) => byId.get(clientId) ?? null };
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(/\s+/u).filter(Boolean))];
}

function validScopes(scopes: string[], allowed: ReadonlySet<string>): boolean {
  return scopes.length > 0 && scopes.every((scope) => allowed.has(scope));
}

function audienceIncludes(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 64 * 1024 || !request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
    return null;
  }
  const text = await request.text();
  return text.length <= 64 * 1024 ? new URLSearchParams(text) : null;
}

function publicSigningJwk(jwk: JsonWebKey, kid: string): JsonWebKey {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, oth: _oth, ...publicFields } = jwk;
  return { ...publicFields, kid, alg: "RS256", use: "sig" } as JsonWebKey;
}

function redirectOAuthError(
  redirectUri: string,
  state: string,
  issuer: string,
  error: string,
  description: string
): Response {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", error);
  redirect.searchParams.set("error_description", description);
  if (state) redirect.searchParams.set("state", state);
  redirect.searchParams.set("iss", issuer);
  return new Response(null, { status: 302, headers: noStoreHeaders({ Location: redirect.toString() }) });
}

function oauthError(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status, "no-store", true);
}

function jsonResponse(value: unknown, status: number, cacheControl: string, noStore = false): Response {
  return Response.json(value, {
    status,
    headers: noStoreHeaders({
      "Cache-Control": cacheControl,
      ...(noStore ? { Pragma: "no-cache" } : {})
    })
  });
}

function noStoreHeaders(additional: Record<string, string> = {}): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...additional
  });
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/u, "");
}

export function decodeJwtClaimsForTesting(token: string): JsonObject {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("Invalid JWT");
  return decodeJwtPart<JsonObject>(segments[1]);
}
