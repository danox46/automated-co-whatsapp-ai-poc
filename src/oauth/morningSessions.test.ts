import { describe, expect, it } from 'vitest';
import type * as oidc from 'openid-client';
import { MorningOperatorSessions, premiumWorkspaceTenant, type MorningLoginStore } from './morningSessions.js';
import { signRs256Jwt, sha256Base64Url } from './jwt.js';

const origin = 'https://whatsapp.fixture.test', issuer = 'https://morning.fixture.test', clientId = 'whatsapp-operator';
const subject = `morning:oidc-${'a'.repeat(32)}`;
const cookie = (response: Response, name: string) => response.headers.getSetCookie().find(x => x.startsWith(name + '='))?.split(';')[0] ?? '';
async function fixture(multiple = false, workspaceId?: string, setup=false) {
  const setupCalls:unknown[]=[];
  let workspaceClaims: Record<string, unknown> = workspaceId ? {workspace_id:workspaceId,workspace_role:"owner"} : {};
  const rows = new Map<string, { value: string; expires: number }>(); let now = Date.now(), tokenCalls = 0, validUserInfo = true, tokenSubject = subject, badNonce = false;
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const store: MorningLoginStore = {
    claimMorningSetup:async(hash,value,expires,at)=>{const key='setup'+hash,prior=rows.get(key);if(prior&&prior.expires>at)return prior.value;rows.set(key,{value,expires});return value;},
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
      expect(fields.get('client_id')).toBe(clientId); expect(fields.get('redirect_uri')).toBe(origin + (workspaceId ? '/premium/auth/callback' : '/auth/callback'));
      expect(await sha256Base64Url(fields.get('code_verifier')!)).toBe(authorization.searchParams.get('code_challenge'));
      const timestamp = Math.floor(Date.now() / 1000);
      return Response.json({ access_token: 'synthetic-morning-identity-access', token_type: 'Bearer', expires_in: 3600,
        id_token: await signRs256Jwt({ alg: 'RS256', kid: 'morning-test' }, { iss: issuer, sub: tokenSubject, aud: clientId, iat: timestamp, exp: timestamp + 300,
          ...workspaceClaims, nonce: badNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce') }, privateJwk) });
    }
    if (url.pathname.endsWith('/userinfo')) return validUserInfo ? Response.json({ sub: tokenSubject, ...workspaceClaims }) : Response.json({ error: 'invalid_token' }, { status: 401 });
    throw new Error('Unexpected fixture request');
  };
  const connected = new Set(multiple ? ['morning-demo', 'client-b'] : ['morning-demo']);
  const sessions = new MorningOperatorSessions({ origin, issuer, clientId, encryptionKey: 'a'.repeat(43),
    bindings: [{ subject, installations: [{ tenantId: 'morning-demo', label: 'Morning demo' }, ...(multiple ? [{ tenantId: 'client-b', label: 'Business B' }] : [])] }],
    ...(workspaceId ? {workspacePolicy:'enrolled-owner' as const} : {}), ...(setup?{customerSetup:{begin:async(value:unknown)=>{setupCalls.push(value);return origin+'/pilot/whatsapp/connect?invite=synthetic';},nativeRedirectUri:'http://127.0.0.1:9468/callback',status:async(tenant:string)=>({connected:connected.has(tenant),name:'Example business'})}}:{}), store, request, now: () => now, installationConnected: async id => connected.has(id),
    installationReference: async id => `inst_${(id === 'client-b' ? 'b' : 'a').repeat(32)}` });
  const returnTo = origin + (setup?'/premium/whatsapp/setup?flow=setup':'/oauth/authorize?client_id=urn%3Amorning%3Awhatsapp-bot&state=native-state') + (workspaceId ? '&workspace_id=' + workspaceId : '');
  const begin = async () => {
    const response = await sessions.start(new Request(returnTo)); expect(response.status).toBe(303);
    authorization = new URL(response.headers.get('location')!);
    const flowCookie = cookie(response, workspaceId ? '__Host-wa_customer_flow' : '__Host-wa_morning_flow');
    const callback = new URL(origin + (workspaceId ? '/premium/auth/callback' : '/auth/callback')); callback.searchParams.set('state', authorization.searchParams.get('state')!); callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('iss', issuer);
    return { callback, flowCookie, finish: () => sessions.handle(new Request(callback, { headers: { cookie: flowCookie } })) };
  };
  return { sessions, rows, begin, returnTo, connected, setupCalls, claims:(value:Record<string,unknown>)=>{workspaceClaims=value;}, authorization:()=>authorization, tokenCalls: () => tokenCalls,
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


describe('Premium workspace WhatsApp identity', () => {
  it('carries the selected workspace to Morning with a separate browser callback and cookie', async () => {
    const f=await fixture(false,'prem-one');
    await f.begin();
    expect(f.authorization().searchParams.get('workspace_id')).toBe('prem-one');
    expect(f.authorization().searchParams.get('redirect_uri')).toBe(origin+'/premium/auth/callback');
  });
  it('rejects foreign workspace and non-owner claims before installation lookup', async () => {
    for(const claims of [{workspace_id:'prem-other',workspace_role:'owner'},{workspace_id:'prem-one',workspace_role:'member'},{}]) {
      const f=await fixture(false,'prem-one'); const flow=await f.begin(); f.claims(claims);
      const response=(await flow.finish())!; expect(response.status).toBe(403);
      expect(cookie(response,'__Host-wa_customer_session')).toBe('');
    }
  });
  it('does not inherit operator installations even for the same identity', async () => {
    const f=await fixture(false,'prem-one'); const response=(await(await f.begin()).finish())!;
    expect(response.status).toBe(403);
    expect(cookie(response,'__Host-wa_customer_session')).toBe('');
  });
  it('requires one workspace selector and rejects it in the legacy flow', async () => {
    const f=await fixture(false,'prem-one');
    for(const query of ['', '&workspace_id=prem-one&workspace_id=prem-two','&workspace_id=../morning']) {
      expect((await f.sessions.start(new Request(origin+'/oauth/authorize?client_id=x'+query))).status).toBe(400);
    }
    const old=await fixture(); expect((await old.sessions.start(new Request(old.returnTo+'&workspace_id=prem-one'))).status).toBe(400);
  });
});

it('keeps two enrolled workspaces of one owner separate through sign-in and fresh membership checks', async()=>{
  const a=await fixture(false,'prem-a'), b=await fixture(false,'prem-b');
  const tenantA=await premiumWorkspaceTenant(issuer,'prem-a'),tenantB=await premiumWorkspaceTenant(issuer,'prem-b');
  expect(tenantA).not.toBe(tenantB);
  a.connected.add(tenantA); b.connected.add(tenantB);
  const flow=await a.begin(),response=(await flow.finish())!, responseB=(await(await b.begin()).finish())!;
  expect(response.status).toBe(303); expect(responseB.status).toBe(303);
  const sessionCookie=cookie(response,'__Host-wa_customer_session');
  expect(await a.sessions.resolve(new Request(a.returnTo,{headers:{cookie:sessionCookie}}))).toMatchObject({tenantId:tenantA,subject});
  expect(await b.sessions.resolve(new Request(b.returnTo,{headers:{cookie:cookie(responseB,'__Host-wa_customer_session')}}))).toMatchObject({tenantId:tenantB,subject});
  const changed=await a.sessions.resolve(new Request(b.returnTo,{headers:{cookie:sessionCookie}})) as Response;
  expect(changed.status).toBe(303); expect(new URL(changed.headers.get('location')!).searchParams.get('workspace_id')).toBe('prem-b');
  a.claims({workspace_id:'prem-a',workspace_role:'member'});
  expect((await a.sessions.resolve(new Request(a.returnTo,{headers:{cookie:sessionCookie}})) as Response).status).toBe(401);
  expect(JSON.stringify([...a.rows.values()])).not.toContain('synthetic-morning-identity-access');
});

describe('Customer-owned WhatsApp setup',()=>{
 it('permits verified owners to prepare a new connection and keeps the invitation intent stable',async()=>{
  const f=await fixture(false,'prem-setup',true),flow=await f.begin(),finished=(await flow.finish())!;
  expect(finished.status).toBe(303); expect(finished.headers.get('location')).toBe(f.returnTo);
  const sessionCookie=cookie(finished,'__Host-wa_customer_session');
  const page=(await f.sessions.handle(new Request(f.returnTo,{headers:{cookie:sessionCookie}})))!;
  expect(page.status).toBe(200);const html=await page.text();expect(html).toContain('Connect WhatsApp');
  const csrf=/name="csrf" value="([^"]+)"/u.exec(html)![1];
  const post=(token=csrf,requestOrigin=origin)=>f.sessions.handle(new Request(f.returnTo,{method:'POST',headers:{cookie:sessionCookie,origin:requestOrigin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:token})}));
  expect((await post('wrong'))?.status).toBe(403);expect((await post(csrf,'https://foreign.test'))?.status).toBe(403);expect(f.setupCalls).toHaveLength(0);
  expect((await post())?.status).toBe(303);expect((await post())?.status).toBe(303);
  expect(f.setupCalls[0]).toEqual(f.setupCalls[1]);
  expect(f.setupCalls[0]).toMatchObject({workspaceId:'prem-setup',tenantId:await premiumWorkspaceTenant(issuer,'prem-setup')});
  f.revoke();expect((await post())?.status).toBe(401);expect(f.setupCalls).toHaveLength(2);
 });
 it('starts sign-in from the setup route without a customer cookie and never creates an invitation on GET',async()=>{
  const f=await fixture(false,'prem-setup',true);
  const response=await f.sessions.handle(new Request(f.returnTo));expect(response?.status).toBe(303);expect(f.setupCalls).toHaveLength(0);
 });
});

it('downloads only the authenticated connected workspace reference for native enrollment',async()=>{
 const f=await fixture(false,'prem-download',true),finish=(await(await f.begin()).finish())!,headers={cookie:cookie(finish,'__Host-wa_customer_session')};
 const download=f.returnTo+'&format=connection';
 expect((await f.sessions.handle(new Request(download,{headers})))?.status).toBe(409);
 const tenant=await premiumWorkspaceTenant(issuer,'prem-download');f.connected.add(tenant);
 const response=(await f.sessions.handle(new Request(download,{headers})))!;
 expect(response.status).toBe(200);expect(response.headers.get('content-disposition')).toContain('attachment');
 const value=await response.json();expect(value).toEqual({version:1,kind:'morning-whatsapp-connection',connection:{label:'Example business',origin,workspaceId:'prem-download',installationRef:'inst_'+ 'a'.repeat(32),redirectUri:'http://127.0.0.1:9468/callback'}});
 expect(JSON.stringify(value)).not.toContain('identityAccessToken');
 f.revoke();expect((await f.sessions.handle(new Request(download,{headers})))?.status).toBe(401);
});
