import { verifyRs256Jwt, type JwtHeader } from "../oauth/jwt.js";
import type { WhatsAppMcpTokenVerifier } from "./auth.js";

export type JwtTokenVerifierOptions = {
  issuer: string;
  audience: string;
  resolvePublicJwk: (header: JwtHeader) => Promise<JsonWebKey | null>;
  isTokenRevoked?: (tokenId: string) => Promise<boolean>;
  now?: () => Date;
  clockSkewSeconds?: number;
};

export function createJwtWhatsAppMcpTokenVerifier(
  options: JwtTokenVerifierOptions
): WhatsAppMcpTokenVerifier {
  return async (bearerToken) => {
    const verified = await verifyRs256Jwt(bearerToken, options.resolvePublicJwk);
    if (!verified) return null;

    const claims = verified.claims;
    const nowSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    const skew = options.clockSkewSeconds ?? 30;
    const subject = stringClaim(claims.sub);
    const tenantId = stringClaim(claims.tenant_id);
    const issuer = stringClaim(claims.iss);
    const tokenId = stringClaim(claims.jti);
    const expiration = numericClaim(claims.exp);
    const notBefore = claims.nbf === undefined ? undefined : numericClaim(claims.nbf);
    const issuedAt = claims.iat === undefined ? undefined : numericClaim(claims.iat);

    if (!subject || !tenantId || !issuer || issuer !== options.issuer) return null;
    if (!audienceIncludes(claims.aud, options.audience)) return null;
    if (expiration === null || expiration === undefined || expiration <= nowSeconds - skew) return null;
    if (notBefore === null || (notBefore !== undefined && notBefore > nowSeconds + skew)) return null;
    if (issuedAt === null || (issuedAt !== undefined && issuedAt > nowSeconds + skew)) return null;
    if (tokenId && await options.isTokenRevoked?.(tokenId)) return null;

    return {
      subject,
      tenantId,
      audience: options.audience,
      scopes: new Set(readScopes(claims.scope)),
      ...(tokenId ? { tokenId } : {})
    };
  };
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numericClaim(value: unknown): number | null | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function audienceIncludes(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.every((item) => typeof item === "string") && value.includes(expected);
}

function readScopes(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/u).filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}
