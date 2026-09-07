const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Base64Url(value: string): Promise<string> {
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
  );
}

export async function secureEqualText(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  const maximum = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < maximum; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function encryptPilotSecret(
  plaintext: string,
  encodedKey: string
): Promise<{ ciphertext: string; iv: string; version: 1 }> {
  const key = await importEncryptionKey(encodedKey, ["encrypt"]);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode("whatsapp-meta-pilot:v1") },
    key,
    encoder.encode(plaintext)
  );
  return { ciphertext: base64UrlEncode(new Uint8Array(ciphertext)), iv: base64UrlEncode(iv), version: 1 };
}

export async function decryptPilotSecret(
  encrypted: { ciphertext: string; iv: string; version: 1 },
  encodedKey: string
): Promise<string> {
  const key = await importEncryptionKey(encodedKey, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(base64UrlDecode(encrypted.iv)),
      additionalData: encoder.encode("whatsapp-meta-pilot:v1")
    },
    key,
    asArrayBuffer(base64UrlDecode(encrypted.ciphertext))
  );
  return decoder.decode(plaintext);
}

async function importEncryptionKey(
  encodedKey: string,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const raw = base64UrlDecode(encodedKey);
  if (raw.byteLength !== 32) {
    throw new Error("INSTALLATION_ENCRYPTION_KEY must be a 32-byte base64url value");
  }
  return crypto.subtle.importKey("raw", asArrayBuffer(raw), { name: "AES-GCM" }, false, usages);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
