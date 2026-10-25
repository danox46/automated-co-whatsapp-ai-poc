import * as oidc from 'openid-client';
import { z } from 'zod';
import { encryptPilotSecret, decryptPilotSecret, randomBase64Url, secureEqualText, sha256Base64Url } from '../meta/pilotCrypto.js';
import type { OAuthAuthorizedSession } from './authorizationServer.js';
import { SUPPORTED_WHATSAPP_MCP_SCOPES } from '../mcp/auth.js';

export type MorningLoginRecordKind = 'flow' | 'session';
export interface MorningLoginStore {
  putMorningLogin(kind: MorningLoginRecordKind, hash: string, encrypted: string, expiresAt: number, nowSeconds: number): Promise<boolean>;
  getMorningLogin(kind: MorningLoginRecordKind, hash: string, nowSeconds: number): Promise<string | null>;
  consumeMorningLoginFlow(hash: string, nowSeconds: number): Promise<string | null>;
  deleteMorningLoginSession(hash: string): Promise<void>;
}
const bindingsSchema = z.array(z.object({ subject: z.string().regex(/^morning:oidc-[a-f0-9]{32}$/u),
  installations: z.array(z.object({ tenantId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), label: z.string().trim().min(1).max(120) }).strict()).min(1).max(64)
}).strict()).min(1).max(32).superRefine((bindings, ctx) => {
  if (new Set(bindings.map(x => x.subject)).size !== bindings.length || bindings.some(x => new Set(x.installations.map(i => i.tenantId)).size !== x.installations.length)) ctx.addIssue({ code: 'custom', message: 'Duplicate operator or installation' });
});
type Flow = { state: string; nonce: string; verifier: string; returnTo: string };
type Session = { subject: string; identityAccessToken: string; tenantId?: string; returnTo: string; csrf: string };
const flowCookie = '__Host-wa_morning_flow', sessionCookie = '__Host-wa_morning_session';
const headers = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const escape = (value: string) => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Morning proves operator identity; only explicit host bindings authorize an installation. */
export class MorningOperatorSessions {
  private readonly bindings: z.infer<typeof bindingsSchema>;
  private configuration?: Promise<oidc.Configuration>;
  constructor(private readonly options: { origin: string; issuer: string; clientId: string; encryptionKey: string;
    bindings: unknown; store: MorningLoginStore; installationConnected: (tenantId: string) => Promise<boolean>;
    installationReference?: (tenantId: string) => Promise<string | null>;
    request?: NonNullable<oidc.DiscoveryRequestOptions[typeof oidc.customFetch]>; now?: () => number;
  }) {
    for (const value of [options.origin, options.issuer]) { const url = new URL(value); if (url.protocol !== 'https:' || url.origin !== value) throw new Error('Exact HTTPS sign-in origins required'); }
    if (!/^[a-z][a-z0-9-]{0,99}$/u.test(options.clientId) || options.clientId === 'confio-sandbox') throw new Error('A separate registered WhatsApp identity client is required');
    this.bindings = bindingsSchema.parse(options.bindings);
  }
  private now() { return Math.floor((this.options.now?.() ?? Date.now()) / 1000); }
  private async config() {
    this.configuration ??= oidc.discovery(new URL(this.options.issuer), this.options.clientId,
      { token_endpoint_auth_method: 'none' }, undefined, { execute: [oidc.enableNonRepudiationChecks], timeout: 10,
        ...(this.options.request ? { [oidc.customFetch]: this.options.request } : {}) }).then(config => {
          const metadata = config.serverMetadata();
          for (const [name, path] of Object.entries({ authorization_endpoint: '/integrations/identity/authorize', token_endpoint: '/integrations/identity/token', userinfo_endpoint: '/integrations/identity/userinfo', jwks_uri: '/integrations/identity/jwks' })) {
            if (metadata[name] !== this.options.issuer + path) throw new Error('Unexpected Morning identity endpoint');
          }
          return config;
        }).catch(error => { this.configuration = undefined; throw error; });
    return this.configuration;
  }
  private cookie(name: string, value: string, maxAge: number) { return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`; }
  private readCookie(request: Request, name: string) {
    const values = (request.headers.get('cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(name + '='));
    if (values.length !== 1) return undefined;
    const value = values[0].slice(name.length + 1); return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
  }
  private namespace() { return JSON.stringify([this.options.origin, this.options.issuer, this.options.clientId]); }
  private async seal(value: unknown) { return JSON.stringify(await encryptPilotSecret(JSON.stringify({ namespace: this.namespace(), value }), this.options.encryptionKey)); }
  private async open<T>(value: string): Promise<T> {
    const parsed = JSON.parse(await decryptPilotSecret(JSON.parse(value), this.options.encryptionKey));
    if (parsed.namespace !== this.namespace()) throw new Error('Sign-in configuration changed');
    return parsed.value as T;
  }
  private binding(subject: string) { return this.bindings.find(x => x.subject === subject); }
  private validReturn(value: string) {
    try { const url = new URL(value); return url.origin === this.options.origin && url.pathname === '/oauth/authorize' && !url.hash && value.length <= 16384; } catch { return false; }
  }
  private requestedReference(value: string): string | Response | undefined {
    const values = new URL(value).searchParams.getAll('installation_ref');
    if (values.length > 1 || (values.length === 1 && !/^inst_[A-Za-z0-9_-]{32}$/u.test(values[0]))) return this.problem('The selected business reference is invalid. Restart bot setup.');
    return values[0];
  }
  private page(title: string, body: string, status = 200, cookies: string[] = []) {
    const responseHeaders = new Headers({ ...headers, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    for (const cookie of cookies) responseHeaders.append('Set-Cookie', cookie);
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Morning</title><style>body{font:16px system-ui;background:#f6f7fb;color:#172b4d;margin:0;display:grid;min-height:100vh;place-items:center}main{width:min(480px,calc(100% - 64px));padding:32px;background:white;border:1px solid #dce3ee;border-radius:20px;box-shadow:0 12px 36px #1831530d}small{color:#4169e1;font-weight:700}h1{font-size:26px}p{line-height:1.6;color:#52637a}button,a{font:inherit}button{border:0;background:#3159da;color:white;border-radius:10px;padding:12px 18px;cursor:pointer}label{display:block;padding:12px;border:1px solid #dce3ee;border-radius:10px;margin:12px 0}a{color:#3159da}</style></head><body><main><small>MORNING</small><h1>${escape(title)}</h1>${body}</main></body></html>`, { status, headers: responseHeaders });
  }
  private problem(message: string, status = 400, cookies: string[] = []) { return this.page('Connection needs attention', `<p>${escape(message)}</p>`, status, cookies); }
  private redirect(location: string, cookies: string[] = []) {
    const h = new Headers({ ...headers, Location: location }); for (const value of cookies) h.append('Set-Cookie', value);
    return new Response(null, { status: 303, headers: h });
  }
  async start(request: Request) {
    if (request.method !== 'GET' || !this.validReturn(request.url)) return this.problem('Restart the connection from the bot setup page.');
    const requested = this.requestedReference(request.url); if (requested instanceof Response) return requested;
    try {
      const config = await this.config(), handle = randomBase64Url(32);
      const flow: Flow = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier(), returnTo: request.url };
      if (!await this.options.store.putMorningLogin('flow', await sha256Base64Url(handle), await this.seal(flow), this.now() + 300, this.now())) throw new Error('Login capacity reached');
      const location = oidc.buildAuthorizationUrl(config, { redirect_uri: this.options.origin + '/auth/callback', scope: 'openid', state: flow.state, nonce: flow.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: 'S256' });
      return this.redirect(location.href, [this.cookie(flowCookie, handle, 300)]);
    } catch { return this.problem('Morning sign-in is temporarily unavailable. No connection was changed. Start the connection again after it recovers.', 503); }
  }
  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url); if (url.origin !== this.options.origin) return null;
    if (url.pathname === '/auth/callback') return request.method === 'GET' ? this.finish(request) : this.problem('Use the sign-in callback link.', 405);
    if (url.pathname === '/auth/select') return this.select(request);
    return null;
  }
  private async finish(request: Request) {
    const url = new URL(request.url), handle = this.readCookie(request, flowCookie), clear = this.cookie(flowCookie, '', 0);
    if (!handle || url.hash || url.href.length > 16384 || ['state', 'code', 'iss', 'error'].some(key => url.searchParams.getAll(key).length > 1)) return this.problem('This sign-in link is invalid or expired. Restart the connection.', 400, [clear]);
    try {
      const hash = await sha256Base64Url(handle), stored = await this.options.store.getMorningLogin('flow', hash, this.now());
      if (!stored) return this.problem('This sign-in has expired or already finished. Restart the connection.', 400, [clear]);
      const flow = await this.open<Flow>(stored);
      if (!this.validReturn(flow.returnTo) || !await secureEqualText(flow.state, url.searchParams.get('state') ?? '')) return this.problem('The sign-in did not match this browser connection. Restart it.', 400, [clear]);
      if (!await this.options.store.consumeMorningLoginFlow(hash, this.now())) return this.problem('This sign-in has already finished. Restart the connection.', 400, [clear]);
      const config = await this.config();
      const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
      const subject = tokens.claims()?.sub;
      if (!subject || !this.binding(subject)) return this.problem('This Morning account is not assigned to a WhatsApp installation. Ask the operator to check the business assignment.', 403, [clear]);
      await oidc.fetchUserInfo(config, tokens.access_token, subject);
      const requested = this.requestedReference(flow.returnTo); if (requested instanceof Response) throw new Error('Invalid installation reference');
      const assigned = await this.connected(subject), choices = requested ? assigned.filter(x => x.installationRef === requested) : assigned;
      if (!choices.length) return this.problem('No connected WhatsApp business is assigned to this account. Complete the business connection first.', 403, [clear]);
      const rawSession = randomBase64Url(32), session: Session = { subject, identityAccessToken: tokens.access_token, returnTo: flow.returnTo, csrf: randomBase64Url(32),
        ...(choices.length === 1 ? { tenantId: choices[0].tenantId } : {}) };
      const lifetime = Math.min(3600, Number(tokens.expires_in ?? 3600));
      if (!Number.isFinite(lifetime) || lifetime < 1) throw new Error('Expired identity');
      if (!await this.options.store.putMorningLogin('session', await sha256Base64Url(rawSession), await this.seal(session), this.now() + Math.floor(lifetime), this.now())) throw new Error('Login session unavailable');
      return this.redirect(session.tenantId ? session.returnTo : this.options.origin + '/auth/select', [clear, this.cookie(sessionCookie, rawSession, Math.floor(lifetime))]);
    } catch { return this.problem('Sign-in did not finish. Restart the connection from the bot setup page.', 400, [clear]); }
  }
  private async connected(subject: string) {
    const allowed = this.binding(subject)?.installations ?? [];
    const present = await Promise.all(allowed.map(async (entry): Promise<(typeof entry & { installationRef?: string }) | undefined> => {
      if (!await this.options.installationConnected(entry.tenantId)) return undefined;
      if (!this.options.installationReference) return entry;
      const installationRef = await this.options.installationReference(entry.tenantId);
      return installationRef && /^inst_[A-Za-z0-9_-]{32}$/u.test(installationRef) ? { ...entry, installationRef } : undefined;
    }));
    return present.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  }
  private async session(request: Request): Promise<{ value: Session; hash: string; sealed: string } | Response | null> {
    const handle = this.readCookie(request, sessionCookie); if (!handle) return null;
    const hash = await sha256Base64Url(handle), sealed = await this.options.store.getMorningLogin('session', hash, this.now()); if (!sealed) return null;
    try {
      const value = await this.open<Session>(sealed);
      if (!this.binding(value.subject) || !this.validReturn(value.returnTo)) throw new Error('Assignment removed');
      await oidc.fetchUserInfo(await this.config(), value.identityAccessToken, value.subject);
      return { value, hash, sealed };
    } catch {
      // Retain saved delegation on provider transport failure; never silently grant or overwrite it.
      return this.problem('Morning could not confirm this sign-in. Reconnect from the bot setup page; the existing bot grant was not changed.', 401, [this.cookie(sessionCookie, '', 0)]);
    }
  }
  async resolve(request: Request): Promise<OAuthAuthorizedSession | Response | null> {
    const requested = this.requestedReference(request.url); if (requested instanceof Response) return requested;
    const current = await this.session(request); if (!current || current instanceof Response) return current;
    const choices = await this.connected(current.value.subject);
    const selected = requested ? choices.find(x => x.installationRef === requested)?.tenantId : current.value.tenantId;
    if (requested && !selected) return this.problem('The requested business is disconnected or not assigned to this Morning account.', 403);
    if (!selected) return this.redirect(this.options.origin + '/auth/select');
    if (!choices.some(x => x.tenantId === selected)) return this.problem('The selected business is disconnected or no longer assigned to this Morning account.', 403);
    return { subject: current.value.subject, tenantId: selected, approvedScopes: new Set(SUPPORTED_WHATSAPP_MCP_SCOPES) };
  }
  private async select(request: Request) {
    const current = await this.session(request);
    if (!current) return this.problem('This sign-in has expired. Restart the connection.', 401);
    if (current instanceof Response) return current;
    const choices = await this.connected(current.value.subject);
    if (!choices.length) return this.problem('No connected business is assigned to this account. Complete the business connection first.', 403);
    if (request.method === 'GET') return this.page('Choose your business', `<p>Select the connected WhatsApp business for this bot.</p><form method="post" action="/auth/select"><input type="hidden" name="csrf" value="${escape(current.value.csrf)}">${choices.map(x => `<label><input type="radio" name="tenantId" value="${escape(x.tenantId)}" required> ${escape(x.label)}</label>`).join('')}<button type="submit">Continue</button></form>`);
    if (request.method !== 'POST') return this.problem('Choose a business using the connection form.', 405);
    if (request.headers.get('origin') !== this.options.origin || !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return this.problem('Restart the business selection form.', 403);
    const body = await request.text(); if (body.length > 2048) return this.problem('Invalid business selection.');
    const fields = new URLSearchParams(body), tenantId = fields.get('tenantId');
    if (fields.getAll('tenantId').length !== 1 || fields.getAll('csrf').length !== 1 || !await secureEqualText(fields.get('csrf') ?? '', current.value.csrf) || !choices.some(x => x.tenantId === tenantId)) return this.problem('That business is not assigned to this connection.', 403);
    // Replace only this existing session; the durable store retains its original expiry.
    if (!await this.options.store.putMorningLogin('session', current.hash, await this.seal({ ...current.value, tenantId }), 0, this.now())) return this.problem('This sign-in expired. Restart the connection.', 401);
    return this.redirect(current.value.returnTo);
  }
}
