import type { OAuthClient } from "./authorizationServer.js";

export const NATIVE_WHATSAPP_BOT_CLIENT_ID = "urn:morning:whatsapp-bot";

/** Opt-in exact native callback; preserves the existing ChatGPT registration. */
export function nativeBotOAuthClient(redirectUri?: string): OAuthClient | null {
  if (!redirectUri) return null;
  const url = new URL(redirectUri);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) < 1 ||
      url.username || url.password || url.pathname !== "/callback" || url.search || url.hash || url.href !== redirectUri) {
    throw new Error("The native bot callback must be an exact HTTP127.0.0.1 port/callback URL");
  }
  return { clientId: NATIVE_WHATSAPP_BOT_CLIENT_ID, redirectUris: [redirectUri] };
}
