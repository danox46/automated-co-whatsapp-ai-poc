export type JsonObject = Record<string, unknown>;

export type JwtHeader = {
  alg: "RS256";
  kid: string;
  typ?: "JWT" | "at+jwt";
};

export function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlDecodeBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "="
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function base64UrlEncodeJson(value: JsonObject): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeJwtPart<T extends JsonObject>(value: string): T {
  const decoded = new TextDecoder().decode(base64UrlDecodeBytes(value));
  const parsed = JSON.parse(decoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT part must be a JSON object");
  }
  return parsed as T;
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

export async function signRs256Jwt(
  header: JwtHeader,
  claims: JsonObject,
  privateJwk: JsonWebKey
): Promise<string> {
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedClaims = base64UrlEncodeJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

export async function verifyRs256Jwt(
  token: string,
  resolveKey: (header: JwtHeader) => Promise<JsonWebKey | null>
): Promise<{ header: JwtHeader; claims: JsonObject } | null> {
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) return null;

  try {
    const header = decodeJwtPart<JwtHeader>(segments[0]);
    if (header.alg !== "RS256" || !header.kid) return null;
    const publicJwk = await resolveKey(header);
    if (!publicJwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signature = base64UrlDecodeBytes(segments[2]);
    const signatureBuffer = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength
    ) as ArrayBuffer;
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBuffer,
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`)
    );
    if (!valid) return null;
    return { header, claims: decodeJwtPart<JsonObject>(segments[1]) };
  } catch {
    return null;
  }
}
