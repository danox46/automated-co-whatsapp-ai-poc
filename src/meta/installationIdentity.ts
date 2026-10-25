/** Stable opaque binding for a bot configuration; never exposes Meta asset IDs. */
export async function opaqueInstallationRef(
  tenantId: string, wabaId: string, phoneNumberId: string, secret: string
): Promise<string> {
  if (!secret || !tenantId || !wabaId || !phoneNumberId) throw new Error("Installation identity is unavailable");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key,
    encoder.encode(JSON.stringify(["whatsapp-installation:v1", tenantId, wabaId, phoneNumberId]))));
  return `inst_${btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "").slice(0, 32)}`;
}
