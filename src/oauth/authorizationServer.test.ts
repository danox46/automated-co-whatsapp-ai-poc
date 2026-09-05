import { describe, expect, it } from "vitest";
import { sha256Base64Url } from "./jwt.js";
import {
  createStaticOAuthClientRegistry,
  createWhatsAppAuthorizationServer,
  decodeJwtClaimsForTesting,
  InMemoryOAuthAuthorizationStore,
  type OAuthAuthorizedSession
} from "./authorizationServer.js";

const issuer = "https://auth.example.test";
const resource = "https://mcp.example.test";
const clientId = "https://chatgpt.com/oauth/client.json";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const now = new Date("2026-09-05T18:00:00.000Z");
const verifier = "local-verifier-with-more-than-forty-three-characters-123456789";

describe("WhatsApp OAuth 2.1 authorization server", () => {
  it("publishes OAuth, OpenID, and public signing-key discovery", async () => {
    const { server } = await fixture();
    const metadata = await server.fetch(new Request(`${issuer}/.well-known/oauth-authorization-server`));
    expect(metadata?.status).toBe(200);
    await expect(metadata?.json()).resolves.toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      userinfo_endpoint: `${issuer}/oauth/userinfo`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: false,
      authorization_response_iss_parameter_supported: true
    });
    const openid = await server.fetch(new Request(`${issuer}/.well-known/openid-configuration`));
    expect(openid?.status).toBe(200);
    const jwks = await server.fetch(new Request(`${issuer}/.well-known/jwks.json`));
    const body = await jwks?.json() as { keys: Array<Record<string, unknown>> };
    expect(body.keys[0]).toMatchObject({ kid: "oauth-key-1", alg: "RS256", use: "sig" });
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("runs authorization code plus PKCE, issues resource-bound tokens, and rotates refresh tokens", async () => {
    const { server } = await fixture();
    const code = await authorize(server);
    const tokenResponse = await exchangeCode(server, code, verifier);
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, string | number>;
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 600 });
    const claims = decodeJwtClaimsForTesting(String(tokens.access_token));
    expect(claims).toMatchObject({
      iss: issuer,
      aud: resource,
      sub: "user-1",
      tenant_id: "tenant-1",
      email: "reviewer@example.test",
      email_verified: true
    });
    await expect(server.verifyIssuedAccessToken(String(tokens.access_token))).resolves.toMatchObject({
      tenant_id: "tenant-1"
    });

    const userInfo = await server.fetch(new Request(`${issuer}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    }));
    await expect(userInfo?.json()).resolves.toEqual({
      sub: "user-1",
      email: "reviewer@example.test",
      email_verified: true
    });

    const refreshResponse = await server.fetch(formRequest(`${issuer}/oauth/token`, {
      grant_type: "refresh_token",
      refresh_token: String(tokens.refresh_token),
      client_id: clientId,
      resource,
      scope: "openid email whatsapp.policy.read"
    }));
    expect(refreshResponse?.status).toBe(200);
    const refreshed = await refreshResponse?.json() as Record<string, string>;
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(refreshed.scope).toBe("openid email whatsapp.policy.read");

    const replay = await server.fetch(formRequest(`${issuer}/oauth/token`, {
      grant_type: "refresh_token",
      refresh_token: String(tokens.refresh_token),
      client_id: clientId,
      resource
    }));
    expect(replay?.status).toBe(400);
    await expect(replay?.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("binds authorization codes to the client, redirect, resource, and one-time PKCE verifier", async () => {
    const { server } = await fixture();
    const code = await authorize(server);
    const wrongVerifier = await exchangeCode(server, code, `${verifier}x`);
    expect(wrongVerifier.status).toBe(400);
    await expect(wrongVerifier.json()).resolves.toMatchObject({ error: "invalid_grant" });
    const replay = await exchangeCode(server, code, verifier);
    expect(replay.status).toBe(400);

    const invalidRedirect = await server.fetch(new Request(`${issuer}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://attacker.example.test/callback",
      resource,
      scope: "whatsapp.policy.read",
      state: "state-1",
      code_challenge_method: "S256",
      code_challenge: await sha256Base64Url(verifier)
    })}`));
    expect(invalidRedirect?.status).toBe(400);
    expect(invalidRedirect?.headers.get("location")).toBeNull();
  });

  it("revokes access and refresh tokens without disclosing whether a token existed", async () => {
    const { server } = await fixture();
    const tokenResponse = await exchangeCode(server, await authorize(server), verifier);
    const tokens = await tokenResponse.json() as Record<string, string>;
    const accessRevocation = await server.fetch(formRequest(`${issuer}/oauth/revoke`, {
      token: tokens.access_token,
      token_type_hint: "access_token"
    }));
    expect(accessRevocation?.status).toBe(200);
    await expect(server.verifyIssuedAccessToken(tokens.access_token)).resolves.toBeNull();

    const refreshRevocation = await server.fetch(formRequest(`${issuer}/oauth/revoke`, {
      token: tokens.refresh_token,
      token_type_hint: "refresh_token"
    }));
    expect(refreshRevocation?.status).toBe(200);
    const refreshAttempt = await server.fetch(formRequest(`${issuer}/oauth/token`, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource
    }));
    await expect(refreshAttempt?.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("requires a signed-in, explicitly scoped tenant session", async () => {
    const noSession = await fixture(null);
    expect((await noSession.server.fetch(await authorizationRequest()))?.status).toBe(401);

    const underScoped = await fixture({
      subject: "user-1",
      tenantId: "tenant-1",
      approvedScopes: new Set(["whatsapp.policy.read"])
    });
    expect((await underScoped.server.fetch(await authorizationRequest()))?.status).toBe(403);
  });
});

async function fixture(session: OAuthAuthorizedSession | null = approvedSession()) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const server = createWhatsAppAuthorizationServer({
    issuer,
    resource,
    signingKey: { kid: "oauth-key-1", privateJwk, publicJwk },
    clients: createStaticOAuthClientRegistry([{ clientId, redirectUris: [redirectUri] }]),
    store: new InMemoryOAuthAuthorizationStore(),
    resolveSession: async () => session,
    now: () => now
  });
  return { server };
}

function approvedSession(): OAuthAuthorizedSession {
  return {
    subject: "user-1",
    tenantId: "tenant-1",
    email: "reviewer@example.test",
    emailVerified: true,
    approvedScopes: new Set([
      "openid",
      "email",
      "whatsapp.policy.read",
      "whatsapp.connection.read",
      "whatsapp.conversations.read",
      "whatsapp.messages.send"
    ])
  };
}

async function authorizationRequest() {
  return new Request(`${issuer}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
    scope: "openid email whatsapp.policy.read whatsapp.conversations.read",
    state: "state-1",
    nonce: "nonce-1",
    code_challenge_method: "S256",
    code_challenge: await sha256Base64Url(verifier)
  })}`);
}

async function authorize(server: Awaited<ReturnType<typeof fixture>>["server"]) {
  const response = await server.fetch(await authorizationRequest());
  expect(response?.status).toBe(302);
  const redirect = new URL(response?.headers.get("location") ?? "");
  expect(redirect.origin + redirect.pathname).toBe(redirectUri);
  expect(redirect.searchParams.get("state")).toBe("state-1");
  expect(redirect.searchParams.get("iss")).toBe(issuer);
  return redirect.searchParams.get("code") ?? "";
}

async function exchangeCode(
  server: Awaited<ReturnType<typeof fixture>>["server"],
  code: string,
  codeVerifier: string
) {
  const response = await server.fetch(formRequest(`${issuer}/oauth/token`, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
    code_verifier: codeVerifier
  }));
  if (!response) throw new Error("Token endpoint was not handled");
  return response;
}

function formRequest(url: string, values: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values)
  });
}
