import { describe, expect, it } from 'vitest';
import type * as oidc from 'openid-client';
import { MorningOperatorSessions, type MorningLoginStore } from './morningSessions.js';
import { signRs256Jwt, sha256Base64Url } from './jwt.js';

const origin = 'https://whatsapp.fixture.test', issuer = 'https://morning.fixture.test', clientId = 'whatsapp-operator';
const subject = `morning:oidc-${'a'.repeat(32)}`;
const cookie = (response: Response, name: string) => response.headers.getSetCookie().find(x => x.startsWith(name + '='))?.split(';')[0] ?? '';
async function fixture(multiple = false) {
  const rows = new Map<string, { value: string; expires: number }>(); let now = Date.now(), tokenCalls = 0, validUserInfo = true, tokenSubject = subject, badNonce = false;
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const store: MorningLoginStore = {
    putMorningLogin: async (kind, hash, value, expires) => { const key = kind + hash; rows.set(key, { value, expires: expires || rows.get(key)!.expires }); return true; },
    getMorningLogin: async (kind, hash, at) => { const row = rows.get(kind + hash); return row && row.expires > at ? row.value : null; },
    consumeMorningLoginFlow: async (hash, at) => { const key = 'flow' + hash, row = rows.get(key); if (!row || row.expires <= at) return null; rows.delete(key); return row.value; },
    deleteMorningLoginSession: async hash => { rows.delete('session' + hash); }
  };
  let authorization: URL;
  const request: NonNullable<oidc.DiscoveryRequestOptions[typeof oidc.customFetch]> = async (target, options) => {
    const req = new Request(target, options as RequestInit), url = new URL(req.url);
    if (url.href === issuer + '/.well-known/openid-configuration') return Response.json({ issuer,
      authorization_endpoint: issuer + '/integrations/identity/authorize', token_endpoint: issuer + '/integrations/identity/token', userinfo_endpoint: issuer + '/integrations/identity/userinfo', jwks_uri: issuer + '/integrations/identity/jwks',
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
    if (url.pathname.endsWith('/jwks')) return Response.json({ keys: [{ ...publicJwk, kid: 'morning-test', alg: 'RS256', use: 'sig' }] });
    if (url.pathname.endsWith('/token')) {
      tokenCalls++; const fields = new URLSearchParams(await req.text());
      expect(fields.get('client_id')).toBe(clientId); expect(fields.get('redirect_uri')).toBe(origin + '/auth/callback');
      expect(await sha256Base64Url(fields.get('code_verifier')!)).toBe(authorization.searchParams.get('code_challenge'));
      const timestamp = Math.floor(Date.now() / 1000);
      return Response.json({ access_token: 'synthetic-morning-identity-access', token_type: 'Bearer', expires_in: 3600,
        id_token: await signRs256Jwt({ alg: 'RS256', kid: 'morning-test' }, { iss: issuer, sub: tokenSubject, aud: clientId, iat: timestamp, exp: timestamp + 300,
          nonce: badNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce') }, privateJwk) });
    }
    if (url.pathname.endsWith('/userinfo')) return validUserInfo ? Response.json({ sub: tokenSubject }) : Response.json({ error: 'invalid_token' }, { status: 401 });
    throw new Error('Unexpected fixture request');
  };
  const connected = new Set(multiple ? ['morning-demo', 'client-b'] : ['morning-demo']);
  const sessions = new MorningOperatorSessions({ origin, issuer, clientId, encryptionKey: 'a'.repeat(43),
    bindings: [{ subject, installations: [{ tenantId: 'morning-demo', label: 'Morning demo' }, ...(multiple ? [{ tenantId: 'client-b', label: 'Business B' }] : [])] }],
    store, request, now: () => now, installationConnected: async id => connected.has(id),
    installationReference: async id => `inst_${(id === 'client-b' ? 'b' : 'a').repeat(32)}` });
  const returnTo = origin + '/oauth/authorize?client_id=urn%3Amorning%3Awhatsapp-bot&state=native-state';
  const begin = async () => {
    const response = await sessions.start(new Request(returnTo)); expect(response.status).toBe(303);
    authorization = new URL(response.headers.get('location')!);
    const flowCookie = cookie(response, '__Host-wa_morning_flow');
    const callback = new URL(origin + '/auth/callback'); callback.searchParams.set('state', authorization.searchParams.get('state')!); callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('iss', issuer);
    return { callback, flowCookie, finish: () => sessions.handle(new Request(callback, { headers: { cookie: flowCookie } })) };
  };
  return { sessions, rows, begin, returnTo, connected, tokenCalls: () => tokenCalls,
    revoke: () => { validUserInfo = false; }, unknownSubject: () => { tokenSubject = `morning:oidc-${'b'.repeat(32)}`; }, corruptNonce: () => { badNonce = true; }, advance: (ms: number) => { now += ms; } };
}
describe('Morning operator to WhatsApp installation sign-in', () => {
  it('restarts identity binding when an unfinished chooser belongs to another OAuth request', async () => {
    const f = await fixture(true), response = (await (await f.begin()).finish())!;
    const sessionCookie = cookie(response, '__Host-wa_morning_session');
    const cloud = new URL(f.returnTo);
    cloud.searchParams.set('client_id', 'https://chatgpt.com/oauth/client.json');
    cloud.searchParams.set('state', 'distinct-cloud-request');
    const resumed = await f.sessions.resolve(new Request(cloud, { headers: { cookie: sessionCookie } })) as Response;
    expect(resumed.status).toBe(303);
    expect(new URL(resumed.headers.get('location')!).origin).toBe(issuer);
    expect(resumed.headers.get('set-cookie')).toContain('__Host-wa_morning_flow=');
    expect(f.tokenCalls()).toBe(1);
  });
  it('honors an assigned profile reference over the browser previous choice and denies foreign or duplicate references', async () => {
    const f = await fixture(true), response = (await (await f.begin()).finish())!, sessionCookie = cookie(response, '__Host-wa_morning_session');
    const picker = (await f.sessions.handle(new Request(origin + '/auth/select', { headers: { cookie: sessionCookie } })))!;
    const csrf = /name="csrf" value="([^"]+)"/u.exec(await picker.text())![1];
    await f.sessions.handle(new Request(origin + '/auth/select', { method: 'POST', headers: { cookie: sessionCookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, tenantId: 'morning-demo' }) }));
    const requested = new URL(f.returnTo); requested.searchParams.set('installation_ref', `inst_${'b'.repeat(32)}`);
    expect(await f.sessions.resolve(new Request(requested, { headers: { cookie: sessionCookie } }))).toMatchObject({ tenantId: 'client-b' });
    requested.searchParams.set('installation_ref', `inst_${'c'.repeat(32)}`);
    expect((await f.sessions.resolve(new Request(requested, { headers: { cookie: sessionCookie } })) as Response).status).toBe(403);
    requested.searchParams.append('installation_ref', `inst_${'a'.repeat(32)}`);
    expect((await f.sessions.resolve(new Request(requested, { headers: { cookie: sessionCookie } })) as Response).status).toBe(400);
  });
  it('uses signed OIDC/PKCE and the explicit subject binding, persists encrypted identity only, and rejects callback replay', async () => {
    const f = await fixture(), flow = await f.begin(), response = (await flow.finish())!;
    expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(f.returnTo);
    const sessionCookie = cookie(response, '__Host-wa_morning_session'); expect(sessionCookie).not.toBe('');
    const resolved = await f.sessions.resolve(new Request(f.returnTo, { headers: { cookie: sessionCookie } }));
    expect(resolved).toMatchObject({ subject, tenantId: 'morning-demo' });
    expect(JSON.stringify([...f.rows.values()])).not.toMatch(/synthetic-morning-identity-access|verifier|returnTo|csrf/);
    expect((await flow.finish())?.status).toBe(400); expect(f.tokenCalls()).toBe(1);
    f.revoke(); expect(await f.sessions.resolve(new Request(f.returnTo, { headers: { cookie: sessionCookie } }))).toBeInstanceOf(Response);
  });
  it('requires this browser/state and a valid nonce; an unassigned signed-in visitor is never treated as owner', async () => {
    const f = await fixture(), flow = await f.begin();
    expect((await f.sessions.handle(new Request(flow.callback)))?.status).toBe(400);
    const wrong = new URL(flow.callback); wrong.searchParams.set('state', 'wrong');
    expect((await f.sessions.handle(new Request(wrong, { headers: { cookie: flow.flowCookie } })))?.status).toBe(400); expect(f.tokenCalls()).toBe(0);
    f.corruptNonce(); expect((await flow.finish())?.status).toBe(400);
    const other = await fixture(); other.unknownSubject(); const pending = await other.begin(); expect((await pending.finish())?.status).toBe(403);
  });
  it('lists only assigned connected businesses, rejects foreign/CSRF selections, and keeps the original session expiry', async () => {
    const f = await fixture(true), response = (await (await f.begin()).finish())!, sessionCookie = cookie(response, '__Host-wa_morning_session');
    expect(response.headers.get('location')).toBe(origin + '/auth/select');
    const picker = (await f.sessions.handle(new Request(origin + '/auth/select', { headers: { cookie: sessionCookie } })))!;
    const html = await picker.text(), csrf = /name="csrf" value="([^"]+)"/u.exec(html)![1];
    const post = (tenantId: string, token = csrf, requestOrigin = origin) => f.sessions.handle(new Request(origin + '/auth/select', { method: 'POST', headers: { cookie: sessionCookie, origin: requestOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ tenantId, csrf: token }) }));
    expect((await post('foreign-tenant'))?.status).toBe(403); expect((await post('client-b', 'wrong'))?.status).toBe(403); expect((await post('client-b', csrf, 'https://other.test'))?.status).toBe(403);
    const before = [...f.rows.values()].map(x => x.expires);
    expect((await post('client-b'))?.status).toBe(303); expect([...f.rows.values()].map(x => x.expires)).toEqual(before);
    expect(await f.sessions.resolve(new Request(f.returnTo, { headers: { cookie: sessionCookie } }))).toMatchObject({ tenantId: 'client-b' });
    f.connected.delete('client-b'); expect((await f.sessions.resolve(new Request(f.returnTo, { headers: { cookie: sessionCookie } })) as Response).status).toBe(403);
  });
  it('expires pending sign-in without exchanging a code and disallows Confio client reuse', async () => {
    const f = await fixture(), flow = await f.begin(); f.advance(301_000);
    expect((await flow.finish())?.status).toBe(400); expect(f.tokenCalls()).toBe(0);
    expect(() => new MorningOperatorSessions({ origin, issuer, clientId: 'confio-sandbox', encryptionKey: 'a'.repeat(43), bindings: [], store: {} as MorningLoginStore, installationConnected: async () => true })).toThrow('separate');
  });
});
