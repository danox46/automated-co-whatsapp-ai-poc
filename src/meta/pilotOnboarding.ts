import { createMetaGraphClient, MetaGraphError } from "./graphClient.js";
import { createPilotInstallationRegistry } from "./pilotInstallationStore.js";
import {
  decryptPilotSecret,
  encryptPilotSecret,
  randomBase64Url,
  secureEqualText
} from "./pilotCrypto.js";
import { SUPPORTED_WHATSAPP_MCP_SCOPES } from "../mcp/auth.js";
import type { WhatsAppSandboxConfig } from "./sandboxConfig.js";

const INVITE_COOKIE = "__Host-wa_pilot_invite";
export const PILOT_SESSION_COOKIE = "__Host-wa_pilot_session";
const MAX_JSON_BYTES = 32 * 1024;
const SESSION_TTL_MS = 10 * 60 * 1000;

export type PilotOnboardingEnv = {
  META_APP_ID: string;
  META_APP_SECRET: string;
  META_GRAPH_API_VERSION: string;
  META_EMBEDDED_SIGNUP_CONFIG_ID: string;
  META_EMBEDDED_SIGNUP_SESSION_VERSION?: string;
  INSTALLATION_ENCRYPTION_KEY: string;
  PILOT_ADMIN_TOKEN: string;
  PUBLIC_ORIGIN: string;
};

export type PilotOnboardingDependencies = {
  registry: ReturnType<typeof createPilotInstallationRegistry>;
  graph: ReturnType<typeof createMetaGraphClient>;
  deleteConversationData: (tenantId: string) => Promise<unknown>;
  createAuthorizationSession: (
    tenantId: string,
    approvedScopes: readonly string[]
  ) => Promise<{ rawSession: string; expiresAt: number }>;
  revokeAuthorizationSessions: (tenantId: string) => Promise<void>;
  sandbox?: WhatsAppSandboxConfig;
  registerSandboxRecipients?: (
    tenantId: string,
    phoneNumberId: string,
    recipients: readonly string[],
    registeredAt: Date
  ) => Promise<void>;
  now?: () => Date;
};

export function createPilotOnboardingHandler(
  env: PilotOnboardingEnv,
  dependencies: PilotOnboardingDependencies
) {
  const now = dependencies.now ?? (() => new Date());
  const publicOrigin = new URL(env.PUBLIC_ORIGIN).origin;

  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname === "/pilot/whatsapp/connect" && request.method === "GET") {
        return connectPage(request);
      }
      if (url.pathname === "/pilot/whatsapp/sandbox" && request.method === "GET") {
        return connectSandbox(request);
      }
      if (url.pathname === "/pilot/whatsapp/callback" && request.method === "POST") {
        return completeSignup(request);
      }
      if (url.pathname === "/admin/pilot/invitations" && request.method === "POST") {
        return createInvitation(request);
      }
      if (url.pathname === "/admin/pilot/invitations/rotate" && request.method === "POST") {
        return createInvitation(request, true);
      }
      if (url.pathname === "/admin/pilot/sandbox/invitations" && request.method === "POST") {
        return createSandboxInvitation(request);
      }
      if (url.pathname === "/admin/pilot/sandbox/invitations/rotate" && request.method === "POST") {
        return createSandboxInvitation(request, true);
      }
      const installationMatch = /^\/admin\/pilot\/installations\/([a-z0-9][a-z0-9_-]{2,63})(?:\/(disconnect))?$/u.exec(url.pathname);
      if (installationMatch && request.method === "GET" && !installationMatch[2]) {
        return getInstallation(request, installationMatch[1]);
      }
      if (installationMatch && request.method === "POST" && installationMatch[2] === "disconnect") {
        return disconnectInstallation(request, installationMatch[1]);
      }
      if (installationMatch && request.method === "DELETE" && !installationMatch[2]) {
        return deleteInstallation(request, installationMatch[1]);
      }
      return null;
    }
  };

  async function connectPage(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("invite");
    if (queryToken) {
      const invite = await dependencies.registry.getInvite(queryToken, now());
      if (!invite) return htmlError("This pilot invitation is invalid, expired, or already used.", 410);
      return new Response(null, {
        status: 303,
        headers: securityHeaders({
          Location: `${publicOrigin}/pilot/whatsapp/connect`,
          "Set-Cookie": inviteCookie(queryToken, invite.expiresAt)
        })
      });
    }

    const inviteToken = readCookie(request, INVITE_COOKIE);
    if (!inviteToken) return htmlError("Open the complete pilot invitation link to continue.", 401);
    const invite = await dependencies.registry.getInvite(inviteToken, now());
    if (!invite) return htmlError("This pilot invitation is invalid, expired, or already used.", 410);

    const state = randomBase64Url(32);
    const sessionExpiresAt = new Date(Math.min(
      Date.parse(invite.expiresAt),
      now().getTime() + SESSION_TTL_MS
    )).toISOString();
    await dependencies.registry.beginSession(inviteToken, state, sessionExpiresAt, now());
    return renderSignupPage({
      label: invite.label,
      state,
      appId: env.META_APP_ID,
      configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID,
      graphVersion: env.META_GRAPH_API_VERSION,
      sessionVersion: env.META_EMBEDDED_SIGNUP_SESSION_VERSION ?? "4"
    });
  }

  async function completeSignup(request: Request): Promise<Response> {
    if (request.headers.get("origin") !== publicOrigin) {
      return jsonError("PILOT_ORIGIN_REJECTED", "The signup response did not originate from this pilot site.", 403);
    }
    const inviteToken = readCookie(request, INVITE_COOKIE);
    if (!inviteToken) return jsonError("PILOT_INVITE_REQUIRED", "Restart from the complete pilot invitation link.", 401);
    const body = await readBoundedJson(request);
    const code = readString(body?.code);
    const state = readString(body?.state);
    const wabaId = readProviderId(body?.wabaId);
    const phoneNumberId = readProviderId(body?.phoneNumberId);
    if (!code || !state || !wabaId || !phoneNumberId) {
      return jsonError("PILOT_CALLBACK_INVALID", "Meta did not return a complete WhatsApp authorization result.", 400);
    }
    const invite = await dependencies.registry.consumeSession(inviteToken, state, now());
    if (!invite) return jsonError("PILOT_SESSION_INVALID", "The signup session expired or was already used. Reload and try again.", 409);

    let accessToken: string | null = null;
    let subscribed = false;
    try {
      const token = await dependencies.graph.exchangeEmbeddedSignupCode(code);
      accessToken = token.accessToken;
      const phone = await dependencies.graph.verifyPhoneBelongsToWaba(accessToken, wabaId, phoneNumberId);
      await dependencies.graph.subscribeApp(accessToken, wabaId);
      subscribed = true;
      const connectedAt = now().toISOString();
      await dependencies.registry.completeInstallation(inviteToken, {
        tenantId: invite.tenantId,
        wabaId,
        phoneNumberId,
        ...(phone.verifiedName ? { verifiedName: phone.verifiedName } : {}),
        ...(phone.displayPhoneNumber ? { displayPhoneNumber: phone.displayPhoneNumber } : {}),
        encryptedAccessToken: await encryptPilotSecret(accessToken, env.INSTALLATION_ENCRYPTION_KEY),
        ...(token.expiresAt ? { tokenExpiresAt: token.expiresAt } : {}),
        connectedAt,
        webhookSubscribedAt: connectedAt,
        status: "connected"
      }, now());
      const authorizationSession = await dependencies.createAuthorizationSession(
        invite.tenantId,
        ["openid", ...SUPPORTED_WHATSAPP_MCP_SCOPES]
      );
      return Response.json({
        ok: true,
        status: "connected",
        tenantId: invite.tenantId,
        providerAssetsBound: true,
        oauthReady: true,
        nextStep: "Add the pilot MCP URL in ChatGPT from this browser to finish the scoped connection."
      }, {
        headers: successfulSignupHeaders(authorizationSession.rawSession, authorizationSession.expiresAt)
      });
    } catch (error) {
      if (subscribed && accessToken) {
        try {
          await dependencies.graph.unsubscribeApp(accessToken, wabaId);
        } catch {
          // The response remains fail-closed. An owner can reconcile the Meta subscription manually.
        }
      }
      const code = error instanceof MetaGraphError ? error.code : "PILOT_INSTALLATION_FAILED";
      return jsonError(code, "WhatsApp authorization could not be completed. No MCP access was enabled.", 502);
    }
  }

  async function connectSandbox(request: Request): Promise<Response> {
    const sandbox = dependencies.sandbox;
    if (!sandbox || !dependencies.registerSandboxRecipients) {
      return jsonError("WHATSAPP_SANDBOX_NOT_CONFIGURED", "The app-owned WhatsApp sandbox is not configured.", 503);
    }
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("invite");
    if (queryToken) {
      const invite = await dependencies.registry.getInvite(queryToken, now());
      if (!invite || invite.cohortRole !== "internal" || invite.tenantId !== sandbox.tenantId) {
        return htmlError("This sandbox invitation is invalid, expired, or already used.", 410);
      }
      return new Response(null, {
        status: 303,
        headers: securityHeaders({
          Location: `${publicOrigin}/pilot/whatsapp/sandbox`,
          "Set-Cookie": inviteCookie(queryToken, invite.expiresAt)
        })
      });
    }

    const inviteToken = readCookie(request, INVITE_COOKIE);
    if (!inviteToken) return htmlError("Open the complete sandbox invitation link to continue.", 401);
    const invite = await dependencies.registry.getInvite(inviteToken, now());
    if (!invite || invite.cohortRole !== "internal" || invite.tenantId !== sandbox.tenantId) {
      return htmlError("This sandbox invitation is invalid, expired, or already used.", 410);
    }

    const state = randomBase64Url(32);
    const sessionExpiresAt = new Date(Math.min(
      Date.parse(invite.expiresAt),
      now().getTime() + SESSION_TTL_MS
    )).toISOString();
    await dependencies.registry.beginSession(inviteToken, state, sessionExpiresAt, now());
    const claimed = await dependencies.registry.consumeSession(inviteToken, state, now());
    if (!claimed) return htmlError("This sandbox invitation was already used. Request a new link.", 409);

    let subscribed = false;
    let authorizationSession: { rawSession: string; expiresAt: number } | null = null;
    try {
      const phone = await dependencies.graph.verifyPhoneBelongsToWaba(
        sandbox.accessToken,
        sandbox.wabaId,
        sandbox.phoneNumberId
      );
      await dependencies.graph.subscribeApp(sandbox.accessToken, sandbox.wabaId);
      subscribed = true;
      const connectedAt = now();
      await dependencies.registerSandboxRecipients(
        sandbox.tenantId,
        sandbox.phoneNumberId,
        sandbox.allowedRecipients,
        connectedAt
      );
      authorizationSession = await dependencies.createAuthorizationSession(
        sandbox.tenantId,
        ["openid", ...SUPPORTED_WHATSAPP_MCP_SCOPES]
      );
      await dependencies.registry.completeInstallation(inviteToken, {
        tenantId: sandbox.tenantId,
        wabaId: sandbox.wabaId,
        phoneNumberId: sandbox.phoneNumberId,
        ...(phone.verifiedName ? { verifiedName: phone.verifiedName } : {}),
        ...(phone.displayPhoneNumber ? { displayPhoneNumber: phone.displayPhoneNumber } : {}),
        encryptedAccessToken: await encryptPilotSecret(sandbox.accessToken, env.INSTALLATION_ENCRYPTION_KEY),
        ...(sandbox.tokenExpiresAt ? { tokenExpiresAt: sandbox.tokenExpiresAt } : {}),
        connectedAt: connectedAt.toISOString(),
        webhookSubscribedAt: connectedAt.toISOString(),
        status: "connected"
      }, connectedAt);
      return renderSandboxConnectedPage(
        invite.label,
        `${publicOrigin}/mcp`,
        authorizationSession.rawSession,
        authorizationSession.expiresAt
      );
    } catch (error) {
      if (authorizationSession) await dependencies.revokeAuthorizationSessions(sandbox.tenantId);
      if (subscribed) {
        try {
          await dependencies.graph.unsubscribeApp(sandbox.accessToken, sandbox.wabaId);
        } catch {
          // Preserve the original fail-closed response; the admin status path supports reconciliation.
        }
      }
      const code = error instanceof MetaGraphError ? error.code : "WHATSAPP_SANDBOX_CONNECTION_FAILED";
      return jsonError(code, "The sandbox connection could not be completed. No MCP access was enabled.", 502);
    }
  }

  async function createInvitation(request: Request, rotate = false): Promise<Response> {
    if (!await isAdmin(request, env.PILOT_ADMIN_TOKEN)) return adminUnauthorized();
    const body = await readBoundedJson(request);
    const tenantId = readString(body?.tenantId);
    const label = readString(body?.label);
    const cohortRole = body?.cohortRole === "internal" || body?.cohortRole === "client"
      ? body.cohortRole
      : null;
    const expiresInHours = typeof body?.expiresInHours === "number" ? body.expiresInHours : 24;
    if (!tenantId || !/^[a-z0-9][a-z0-9_-]{2,63}$/u.test(tenantId) ||
        !label || label.length > 120 || !cohortRole || !Number.isInteger(expiresInHours) ||
        expiresInHours < 1 || expiresInHours > 72) {
      return jsonError("PILOT_INVITATION_INVALID", "Expected a safe tenant ID, label, and expiry from 1 to 72 hours.", 400);
    }
    if (await dependencies.registry.getInstallation(tenantId)) {
      return jsonError("PILOT_TENANT_ALREADY_CONNECTED", "This pilot tenant already has an installation.", 409);
    }
    const expiresAt = new Date(now().getTime() + expiresInHours * 60 * 60 * 1000).toISOString();
    let token: string;
    try {
      token = rotate
        ? await dependencies.registry.rotateInvite({ tenantId, label, cohortRole, expiresAt }, now())
        : await dependencies.registry.createInvite({ tenantId, label, cohortRole, expiresAt }, now());
    } catch {
      return rotate
        ? jsonError("PILOT_INVITATION_NOT_ROTATABLE", "No matching unused invitation is available to rotate for this tenant.", 409)
        : jsonError("PILOT_COHORT_LIMIT_REACHED", "The approved closed-pilot cohort has no available seat for this role.", 409);
    }
    return Response.json({
      ok: true,
      tenantId,
      cohortRole,
      expiresAt,
      rotated: rotate,
      invitationUrl: `${publicOrigin}/pilot/whatsapp/connect?invite=${encodeURIComponent(token)}`,
      disclosure: "This one-time link grants only the bounded WhatsApp pilot onboarding flow."
    }, { status: 201, headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8" }) });
  }

  async function createSandboxInvitation(request: Request, rotate = false): Promise<Response> {
    if (!await isAdmin(request, env.PILOT_ADMIN_TOKEN)) return adminUnauthorized();
    const sandbox = dependencies.sandbox;
    if (!sandbox || !dependencies.registerSandboxRecipients) {
      return jsonError("WHATSAPP_SANDBOX_NOT_CONFIGURED", "Configure the app-owned sandbox before creating its invitation.", 503);
    }
    if (await dependencies.registry.getInstallation(sandbox.tenantId)) {
      return jsonError("PILOT_TENANT_ALREADY_CONNECTED", "The sandbox tenant already has an installation.", 409);
    }
    const body = await readBoundedJson(request);
    const label = readString(body?.label);
    const expiresInHours = typeof body?.expiresInHours === "number" ? body.expiresInHours : 24;
    if (!label || label.length > 120 || !Number.isInteger(expiresInHours) ||
        expiresInHours < 1 || expiresInHours > 24) {
      return jsonError("WHATSAPP_SANDBOX_INVITATION_INVALID", "Expected a safe label and expiry from 1 to 24 hours.", 400);
    }
    const expiresAt = new Date(now().getTime() + expiresInHours * 60 * 60 * 1000).toISOString();
    try {
      const invitation = {
        tenantId: sandbox.tenantId,
        label,
        cohortRole: "internal" as const,
        expiresAt
      };
      const token = rotate
        ? await dependencies.registry.rotateInvite(invitation, now())
        : await dependencies.registry.createInvite(invitation, now());
      return Response.json({
        ok: true,
        tenantId: sandbox.tenantId,
        cohortRole: "internal",
        expiresAt,
        rotated: rotate,
        invitationUrl: `${publicOrigin}/pilot/whatsapp/sandbox?invite=${encodeURIComponent(token)}`,
        disclosure: "This one-time link connects only the app-owned WhatsApp test number and its server allowlist."
      }, { status: 201, headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8" }) });
    } catch {
      return rotate
        ? jsonError("WHATSAPP_SANDBOX_INVITATION_NOT_ROTATABLE", "No matching unused sandbox invitation is available to rotate.", 409)
        : jsonError("PILOT_COHORT_LIMIT_REACHED", "The approved internal sandbox seat is unavailable.", 409);
    }
  }

  async function getInstallation(request: Request, tenantId: string): Promise<Response> {
    if (!await isAdmin(request, env.PILOT_ADMIN_TOKEN)) return adminUnauthorized();
    const installation = await dependencies.registry.getInstallation(tenantId);
    if (!installation) return jsonError("PILOT_INSTALLATION_NOT_FOUND", "No installation exists for this pilot tenant.", 404);
    return Response.json({ ok: true, installation: dependencies.registry.sanitize(installation) }, {
      headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8" })
    });
  }

  async function disconnectInstallation(request: Request, tenantId: string): Promise<Response> {
    if (!await isAdmin(request, env.PILOT_ADMIN_TOKEN)) return adminUnauthorized();
    const installation = await dependencies.registry.getInstallation(tenantId);
    if (!installation) return jsonError("PILOT_INSTALLATION_NOT_FOUND", "No installation exists for this pilot tenant.", 404);
    if (installation.status === "disconnected") {
      return Response.json({ ok: true, status: "disconnected", alreadyDisconnected: true }, {
        headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8" })
      });
    }
    const accessToken = await decryptPilotSecret(installation.encryptedAccessToken, env.INSTALLATION_ENCRYPTION_KEY);
    try {
      await dependencies.graph.unsubscribeApp(accessToken, installation.wabaId);
    } catch (error) {
      const code = error instanceof MetaGraphError ? error.code : "PILOT_DISCONNECT_FAILED";
      return jsonError(code, "Meta access could not be disconnected. The local installation remains active for reconciliation.", 502);
    }
    await dependencies.registry.disconnect(tenantId, now());
    await dependencies.revokeAuthorizationSessions(tenantId);
    return Response.json({ ok: true, status: "disconnected" }, {
      headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8" })
    });
  }

  async function deleteInstallation(request: Request, tenantId: string): Promise<Response> {
    if (!await isAdmin(request, env.PILOT_ADMIN_TOKEN)) return adminUnauthorized();
    const body = await readBoundedJson(request);
    if (body?.confirmation !== `DELETE ${tenantId}`) {
      return jsonError("PILOT_DELETION_CONFIRMATION_REQUIRED", `Send confirmation exactly as DELETE ${tenantId}.`, 400);
    }
    const installation = await dependencies.registry.getInstallation(tenantId);
    if (!installation) return jsonError("PILOT_INSTALLATION_NOT_FOUND", "No installation exists for this pilot tenant.", 404);
    if (installation.status !== "disconnected") {
      return jsonError("PILOT_DISCONNECT_REQUIRED", "Disconnect Meta access before deleting retained pilot data.", 409);
    }
    await dependencies.deleteConversationData(tenantId);
    await dependencies.registry.deleteInstallation(tenantId);
    return Response.json({ ok: true, status: "deleted", conversationDataDeleted: true }, {
      headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
}

function renderSignupPage(input: {
  label: string;
  state: string;
  appId: string;
  configId: string;
  graphVersion: string;
  sessionVersion: string;
}): Response {
  const nonce = randomBase64Url(18);
  const config = JSON.stringify({
    state: input.state,
    appId: input.appId,
    configId: input.configId,
    graphVersion: input.graphVersion,
    sessionVersion: input.sessionVersion
  }).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect WhatsApp · Automated &amp; CO</title>
<style nonce="${nonce}">:root{color-scheme:dark}body{margin:0;background:#0c1015;color:#f5f7fa;font:16px/1.5 system-ui,sans-serif}.shell{max-width:720px;margin:8vh auto;padding:32px}.card{background:#151b23;border:1px solid #2a3442;border-radius:18px;padding:32px}h1{font-size:2rem;margin:.2rem 0 1rem}.eyebrow{color:#64d7ba;text-transform:uppercase;letter-spacing:.12em;font-weight:700;font-size:.78rem}.muted{color:#a9b4c2}button{background:#64d7ba;color:#07120f;border:0;border-radius:10px;padding:14px 20px;font-weight:800;font-size:1rem;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.status{min-height:1.5em;margin-top:16px}.fine{font-size:.86rem;color:#8693a3;margin-top:24px}</style></head>
<body><main class="shell"><section class="card"><div class="eyebrow">Invited WhatsApp pilot</div><h1>Connect ${escapeHtml(input.label)}</h1>
<p>Sign in to Meta and choose only the business-owned WhatsApp account and phone number approved for this pilot. Automated &amp; CO never asks for your Meta password, MFA code, or permanent access token.</p>
<ul class="muted"><li>Your WhatsApp assets remain owned by your business.</li><li>The MCP receives tenant-isolated access to connection status, policy guidance, structured conversation history, replies inside the verified 24-hour window, and approved templates.</li><li>Every send is still checked against the connected account, recipient consent, service window, template approval, and idempotency state.</li><li>You can disconnect and request deletion through the pilot support process.</li></ul>
<button id="connect" type="button" disabled>Loading Meta authorization…</button><p id="status" class="status" role="status" aria-live="polite"></p>
<p class="fine">This one-time invitation is limited to the closed development pilot. It does not authorize campaigns, bulk messaging, or unrelated use.</p></section></main>
<div id="fb-root"></div><script nonce="${nonce}">const cfg=${config};let assets=null;let authCode=null;const button=document.getElementById('connect');const status=document.getElementById('status');
function setStatus(message){status.textContent=message}function finish(){if(!assets||!authCode)return;button.disabled=true;setStatus('Securing your WhatsApp connection…');fetch('/pilot/whatsapp/callback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:cfg.state,code:authCode,wabaId:assets.wabaId,phoneNumberId:assets.phoneNumberId})}).then(async response=>{const body=await response.json();if(!response.ok)throw new Error(body?.error?.message||'Connection failed.');setStatus('WhatsApp is connected for the supervised pilot. You may close this page.');button.hidden=true}).catch(error=>{setStatus(error.message);button.disabled=false})}
window.addEventListener('message',event=>{if(event.origin!=='https://www.facebook.com'&&event.origin!=='https://web.facebook.com')return;let data=event.data;try{if(typeof data==='string')data=JSON.parse(data)}catch{return}if(data?.type!=='WA_EMBEDDED_SIGNUP')return;if(data.event==='FINISH'){const wabaId=data.data?.waba_id;const phoneNumberId=data.data?.phone_number_id;if(/^\\d{3,32}$/.test(wabaId)&&/^\\d{3,32}$/.test(phoneNumberId)){assets={wabaId,phoneNumberId};finish()}}else if(data.event==='CANCEL'){setStatus('Meta signup was cancelled. Nothing was connected.')}else if(data.event==='ERROR'){setStatus('Meta could not complete signup. Nothing was connected.')}});
window.fbAsyncInit=()=>{FB.init({appId:cfg.appId,cookie:false,xfbml:false,version:cfg.graphVersion});button.disabled=false;button.textContent='Continue with Meta';button.addEventListener('click',()=>{button.disabled=true;setStatus('Waiting for Meta authorization…');FB.login(response=>{authCode=response?.authResponse?.code||null;if(!authCode){setStatus('Meta authorization was not completed. Nothing was connected.');button.disabled=false;return}finish()},{config_id:cfg.configId,response_type:'code',override_default_response_type:true,extras:{sessionInfoVersion:cfg.sessionVersion}})},{once:false})};
const sdk=document.createElement('script');sdk.src='https://connect.facebook.net/en_US/sdk.js';sdk.async=true;sdk.defer=true;sdk.crossOrigin='anonymous';sdk.nonce='${nonce}';document.body.appendChild(sdk);</script></body></html>`;
  return new Response(html, {
    headers: securityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://connect.facebook.net; style-src 'nonce-${nonce}'; connect-src 'self' https://www.facebook.com https://web.facebook.com; frame-src https://www.facebook.com https://web.facebook.com; img-src data: https://www.facebook.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
    })
  });
}

function renderSandboxConnectedPage(
  label: string,
  mcpUrl: string,
  rawSession: string,
  expiresAtSeconds: number
): Response {
  const nonce = randomBase64Url(18);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp sandbox connected · Automated &amp; CO</title>
<style nonce="${nonce}">:root{color-scheme:dark}body{margin:0;background:#0c1015;color:#f5f7fa;font:16px/1.5 system-ui,sans-serif}.shell{max-width:720px;margin:8vh auto;padding:32px}.card{background:#151b23;border:1px solid #2a3442;border-radius:18px;padding:32px}h1{font-size:2rem;margin:.2rem 0 1rem}.eyebrow{color:#64d7ba;text-transform:uppercase;letter-spacing:.12em;font-weight:700;font-size:.78rem}.muted{color:#a9b4c2}code{display:block;padding:14px;border-radius:10px;background:#0c1015;color:#b9f5e4;overflow-wrap:anywhere}.fine{font-size:.86rem;color:#8693a3;margin-top:24px}</style></head>
<body><main class="shell"><section class="card"><div class="eyebrow">App-owned test environment</div><h1>${escapeHtml(label)} is connected</h1>
<p>The Meta test number is bound to an internal sandbox tenant. Provider sends are restricted again at dispatch time to the server-side recipient allowlist.</p>
<p class="muted">Add this MCP URL to ChatGPT from this same browser session:</p><code>${escapeHtml(mcpUrl)}</code>
<p class="muted">Free-form messages still require a verified inbound message within 24 hours. Outside that window, only an enabled provider-approved template with recorded consent can send.</p>
<p class="fine">This page never displays the test recipient, provider token, WABA identifier, phone-number identifier, or invitation secret.</p></section></main></body></html>`;
  const headers = securityHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  });
  headers.append("Set-Cookie", clearInviteCookie());
  headers.append("Set-Cookie", authorizationCookie(rawSession, expiresAtSeconds));
  return new Response(html, { headers });
}

function htmlError(message: string, status: number): Response {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Pilot invitation</title></head><body><main><h1>WhatsApp pilot</h1><p>${escapeHtml(message)}</p></main></body></html>`, {
    status,
    headers: securityHeaders({ "Content-Type": "text/html; charset=utf-8" })
  });
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8" })
  });
}

function adminUnauthorized(): Response {
  const response = jsonError("PILOT_ADMIN_AUTH_REQUIRED", "Valid pilot administrator authorization is required.", 401);
  response.headers.set("WWW-Authenticate", "Bearer");
  return response;
}

async function isAdmin(request: Request, expected: string): Promise<boolean> {
  const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
  return Boolean(match && expected && await secureEqualText(match[1], expected));
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function inviteCookie(value: string, expiresAt: string): string {
  return `${INVITE_COOKIE}=${encodeURIComponent(value)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

function clearInviteCookie(): string {
  return `${INVITE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function authorizationCookie(value: string, expiresAtSeconds: number): string {
  return `${PILOT_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Expires=${new Date(expiresAtSeconds * 1000).toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

function successfulSignupHeaders(rawSession: string, expiresAtSeconds: number): Headers {
  const headers = securityHeaders({ "Content-Type": "application/json; charset=utf-8" });
  headers.append("Set-Cookie", clearInviteCookie());
  headers.append("Set-Cookie", authorizationCookie(rawSession, expiresAtSeconds));
  return headers;
}

function securityHeaders(additional: Record<string, string> = {}): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ...additional
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readProviderId(value: unknown): string | null {
  return typeof value === "string" && /^\d{3,32}$/u.test(value) ? value : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character] as string);
}
