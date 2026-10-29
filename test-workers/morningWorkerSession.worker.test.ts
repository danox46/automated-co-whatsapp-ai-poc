import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createPersistentWhatsAppWorker, type PersistentWhatsAppWorkerEnv } from '../src/mcp/persistentWorker.js';
import { createDurableOAuthState } from '../src/oauth/durableAuthorizationStore.js';
import { createPilotInstallationRegistry } from '../src/meta/pilotInstallationStore.js';
import { encryptPilotSecret, randomBase64Url, sha256Base64Url } from '../src/meta/pilotCrypto.js';
import { NATIVE_WHATSAPP_BOT_CLIENT_ID } from '../src/oauth/nativeBotClient.js';
import { SUPPORTED_WHATSAPP_MCP_SCOPES } from '../src/mcp/auth.js';
import { opaqueInstallationRef } from '../src/meta/installationIdentity.js';

describe('Worker Morning identity routing', () => {
  it.each([
    { clientId: NATIVE_WHATSAPP_BOT_CLIENT_ID, redirectUri: 'http://127.0.0.1:9468/callback', native: true },
    { clientId: 'https://chatgpt.com/oauth/client.json', redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect', native: false }
  ])('starts repeated $clientId logins without a stale onboarding cookie or request-owned Durable Object stub', async ({ clientId, redirectUri, native }) => {
    const issuer = 'https://morning.fixture.test'; let requestGeneration = 0;
    const effective = { ...env, BOT_OAUTH_REDIRECT_URI: native ? redirectUri : undefined, MORNING_ISSUER: issuer,
      MORNING_CLIENT_ID: 'whatsapp-internal-bot', MORNING_OPERATOR_BINDINGS: JSON.stringify([
        { subject: `morning:oidc-${'a'.repeat(32)}`, installations: [{ tenantId: 'fixture', label: 'Fixture' }] }
      ]), OAUTH_STATE: { getByName(name: string) {
        const owner = requestGeneration, target = env.OAUTH_STATE.getByName(name);
        // Cloudflare request-owned I/O must not survive its originating request.
        // Keep real SQLite/RPC storage while making the request lifetime explicit.
        return new Proxy(target, { get(stub, property) {
          const member = Reflect.get(stub, property, stub);
          return typeof member !== 'function' ? member : (...args: unknown[]) => {
            if (owner !== requestGeneration) throw new Error('Cannot perform I/O on behalf of a different request');
            return Reflect.apply(member, stub, args);
          };
        } });
      } }
    } as unknown as PersistentWhatsAppWorkerEnv;
    const worker = createPersistentWhatsAppWorker({ morningRequest: async () => Response.json({ issuer,
      authorization_endpoint: issuer + '/integrations/identity/authorize', token_endpoint: issuer + '/integrations/identity/token',
      userinfo_endpoint: issuer + '/integrations/identity/userinfo', jwks_uri: issuer + '/integrations/identity/jwks',
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] }) });
    const location = 'https://pilot.test/oauth/authorize?' + new URLSearchParams({ client_id: clientId,
      redirect_uri: redirectUri, response_type: 'code', resource: 'https://pilot.test', scope: 'whatsapp.connection.read',
      code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 'synthetic-native-request' });
    for (let index = 0; index < 3; index++) {
      requestGeneration++;
      const response = await worker.fetch(new Request(location), effective);
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get('location')!).origin).toBe(issuer);
    }
  });
  it('binds the native bot to the selected Morning installation even when the browser retains another Meta pilot cookie; existing clients retain their pilot path', async () => {
    const origin = 'https://pilot.test', issuer = 'https://morning.fixture.test', subject = `morning:oidc-${'a'.repeat(32)}`;
    const selected = `morning_${crypto.randomUUID().replaceAll('-', '')}`, old = `pilot_${crypto.randomUUID().replaceAll('-', '')}`;
    const effective = { ...env, BOT_OAUTH_REDIRECT_URI: 'http://127.0.0.1:9468/callback', MORNING_ISSUER: issuer, MORNING_CLIENT_ID: 'whatsapp-internal-bot',
      MORNING_OPERATOR_BINDINGS: JSON.stringify([{ subject, installations: [{ tenantId: selected, label: 'Selected business' }] }]) } as unknown as PersistentWhatsAppWorkerEnv;
    const registry = createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
    const suffix = crypto.getRandomValues(new Uint32Array(1))[0].toString().padStart(10, '0');
    await registry.refreshInstallation({ tenantId: selected, wabaId: '800' + suffix, phoneNumberId: '900' + suffix,
      encryptedAccessToken: await encryptPilotSecret('synthetic-meta-fixture-only', effective.INSTALLATION_ENCRYPTION_KEY!), connectedAt: new Date().toISOString(), webhookSubscribedAt: new Date().toISOString(), status: 'connected' });
    const state = createDurableOAuthState(env.OAUTH_STATE), prior = await state.createPilotSession(old, SUPPORTED_WHATSAPP_MCP_SCOPES);
    const rawSession = randomBase64Url(32), now = Math.floor(Date.now() / 1000);
    const authorization = (clientId: string, redirectUri: string) => new URL(origin + '/oauth/authorize?' + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
      response_type: 'code', resource: origin, scope: 'whatsapp.policy.read whatsapp.connection.read', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 'native-state' }));
    const nativeUrl = authorization(NATIVE_WHATSAPP_BOT_CLIENT_ID, effective.BOT_OAUTH_REDIRECT_URI!);
    nativeUrl.searchParams.set('installation_ref', await opaqueInstallationRef(selected, '800' + suffix, '900' + suffix, effective.CONVERSATION_REF_SECRET));
    const value = { subject, identityAccessToken: 'synthetic-morning-fixture-only', tenantId: selected, returnTo: nativeUrl.href, csrf: randomBase64Url(32) };
    const sealed = await encryptPilotSecret(JSON.stringify({ namespace: JSON.stringify([origin, issuer, effective.MORNING_CLIENT_ID]), value }), effective.INSTALLATION_ENCRYPTION_KEY!);
    await state.morningStore.putMorningLogin('session', await sha256Base64Url(rawSession), JSON.stringify(sealed), now + 600, now);
    const worker = createPersistentWhatsAppWorker({ morningRequest: async (target) => {
      const url = new URL(target.toString());
      if (url.pathname === '/.well-known/openid-configuration') return Response.json({ issuer,
        authorization_endpoint: issuer + '/integrations/identity/authorize', token_endpoint: issuer + '/integrations/identity/token', userinfo_endpoint: issuer + '/integrations/identity/userinfo', jwks_uri: issuer + '/integrations/identity/jwks',
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
      if (url.pathname === '/integrations/identity/userinfo') return Response.json({ sub: subject });
      throw new Error('Unexpected external fixture request');
    } });
    const cookies = `__Host-wa_pilot_session=${prior.rawSession}; __Host-wa_morning_session=${rawSession}`;
    const native = await worker.fetch(new Request(nativeUrl, { headers: { cookie: cookies } }), effective);
    expect(native.status).toBe(302);
    const code = new URL(native.headers.get('location')!).searchParams.get('code')!;
    expect(await state.store.consumeAuthorizationCode(await sha256Base64Url(code))).toMatchObject({ tenantId: selected, subject });
    const wrong = new URL(nativeUrl); wrong.searchParams.set('installation_ref', 'inst_' + 'z'.repeat(32));
    expect((await worker.fetch(new Request(wrong, { headers: { cookie: cookies } }), effective)).status).toBe(403);
    const legacyUrl = authorization('https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect');
    const legacy = await worker.fetch(new Request(legacyUrl, { headers: { cookie: cookies } }), effective);
    expect(legacy.status).toBe(302);
    const legacyCode = new URL(legacy.headers.get('location')!).searchParams.get('code')!;
    expect(await state.store.consumeAuthorizationCode(await sha256Base64Url(legacyCode))).toMatchObject({ tenantId: old });
    const cloudReentry = await worker.fetch(new Request(legacyUrl, { headers: { cookie: `__Host-wa_morning_session=${rawSession}` } }), effective);
    expect(cloudReentry.status).toBe(302);
    const cloudCode = new URL(cloudReentry.headers.get('location')!).searchParams.get('code')!;
    expect(await state.store.consumeAuthorizationCode(await sha256Base64Url(cloudCode))).toMatchObject({ tenantId: selected, subject });
    const expiredPilot = await worker.fetch(new Request(legacyUrl, { headers: { cookie: `__Host-wa_pilot_session=${'z'.repeat(43)}; __Host-wa_morning_session=${rawSession}` } }), effective);
    expect(expiredPilot.status).toBe(302);
    const expiredPilotCode = new URL(expiredPilot.headers.get('location')!).searchParams.get('code')!;
    expect(await state.store.consumeAuthorizationCode(await sha256Base64Url(expiredPilotCode))).toMatchObject({ tenantId: selected, subject });
    const foreignClient = new URL(legacyUrl); foreignClient.searchParams.set('client_id', 'https://foreign.test/client');
    expect((await worker.fetch(new Request(foreignClient), effective)).status).toBe(400);
    const foreignRedirect = new URL(legacyUrl); foreignRedirect.searchParams.set('redirect_uri', 'https://foreign.test/callback');
    expect((await worker.fetch(new Request(foreignRedirect), effective)).status).toBe(400);
    const fresh = await worker.fetch(new Request(nativeUrl, { headers: { cookie: `__Host-wa_pilot_session=${prior.rawSession}` } }), effective);
    expect(fresh.status).toBe(303); expect(new URL(fresh.headers.get('location')!).origin).toBe(issuer);
  });
});

it('routes enrolled workspaces through the customer identity registration without operator bindings or pilot cookie fallback',async()=>{
 const issuer='https://morning.fixture.test';
 const effective={...env,MORNING_ISSUER:issuer,MORNING_CUSTOMER_CLIENT_ID:'whatsapp-customer'} as unknown as PersistentWhatsAppWorkerEnv;
 const worker=createPersistentWhatsAppWorker({morningRequest:async()=>Response.json({issuer,
 authorization_endpoint:issuer+'/integrations/identity/authorize',token_endpoint:issuer+'/integrations/identity/token',
 userinfo_endpoint:issuer+'/integrations/identity/userinfo',jwks_uri:issuer+'/integrations/identity/jwks',response_types_supported:['code'],
 subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']})});
 const previous=await createDurableOAuthState(env.OAUTH_STATE).createPilotSession('other-business',SUPPORTED_WHATSAPP_MCP_SCOPES);
 const url='https://pilot.test/oauth/authorize?'+new URLSearchParams({client_id:'https://chatgpt.com/oauth/client.json',redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',response_type:'code',resource:'https://pilot.test',scope:'whatsapp.connection.read',code_challenge_method:'S256',code_challenge:'a'.repeat(43),state:'premium-state',workspace_id:'prem-fixture'});
 const response=await worker.fetch(new Request(url,{headers:{cookie:'__Host-wa_pilot_session='+previous.rawSession}}),effective);
 expect(response.status).toBe(303);
 const destination=new URL(response.headers.get('location')!);
 expect(destination.searchParams.get('client_id')).toBe('whatsapp-customer');
 expect(destination.searchParams.get('workspace_id')).toBe('prem-fixture');
 expect(destination.searchParams.get('redirect_uri')).toBe('https://pilot.test/premium/auth/callback');
 expect(response.headers.get('set-cookie')).toContain('__Host-wa_customer_flow=');
 const disabled=await worker.fetch(new Request(url,{headers:{cookie:'__Host-wa_pilot_session='+previous.rawSession}}),{...effective,MORNING_CUSTOMER_CLIENT_ID:undefined});
 expect(disabled.status).toBe(503);
});


it('opens customer setup and resumes one durable invitation without accepting another workspace',async()=>{
 const origin='https://pilot.test',issuer='https://morning.fixture.test',workspaceId='prem-onboarding',subject=`morning:oidc-${'b'.repeat(32)}`;
 const prefix=crypto.randomUUID();
 const namespace={getByName:(name:string)=>env.PILOT_INSTALLATIONS.getByName(prefix+name)};
 const effective={...env,PILOT_INSTALLATIONS:namespace,MORNING_ISSUER:issuer,MORNING_CUSTOMER_CLIENT_ID:'whatsapp-customer'} as unknown as PersistentWhatsAppWorkerEnv;
 const state=createDurableOAuthState(env.OAUTH_STATE),rawSession=randomBase64Url(32),now=Math.floor(Date.now()/1000),csrf=randomBase64Url(32);
 const url=origin+'/premium/whatsapp/setup?workspace_id='+workspaceId;
 const value={subject,workspaceId,identityAccessToken:'synthetic-owner-token',returnTo:url,csrf,setupIntent:{token:randomBase64Url(32),createdAt:new Date(now*1000).toISOString(),expiresAt:new Date((now+600)*1000).toISOString()}};
 const sealed=await encryptPilotSecret(JSON.stringify({namespace:JSON.stringify([origin,issuer,effective.MORNING_CUSTOMER_CLIENT_ID,'enrolled-owner']),value}),effective.INSTALLATION_ENCRYPTION_KEY!);
 await state.morningStore.putMorningLogin('session',await sha256Base64Url(rawSession),JSON.stringify(sealed),now+600,now);
 const worker=createPersistentWhatsAppWorker({morningRequest:async target=>new URL(target.toString()).pathname==='/.well-known/openid-configuration'?Response.json({issuer,
 authorization_endpoint:issuer+'/integrations/identity/authorize',token_endpoint:issuer+'/integrations/identity/token',userinfo_endpoint:issuer+'/integrations/identity/userinfo',jwks_uri:issuer+'/integrations/identity/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']}):Response.json({sub:subject,workspace_id:workspaceId,workspace_role:'owner'})});
 const headers={cookie:'__Host-wa_customer_session='+rawSession};
 const unavailable=await worker.fetch(new Request(url,{headers}),{...effective,META_EMBEDDED_SIGNUP_CONFIG_ID:undefined});expect(unavailable.status).toBe(503);
 const page=await worker.fetch(new Request(url,{headers}),effective);expect(page.status).toBe(200);expect(await page.text()).toContain('Continue to Meta setup');
 const post=()=>new Request(url,{method:'POST',headers:{...headers,origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf})});
 const first=await worker.fetch(post(),effective),second=await worker.fetch(post(),effective);
 expect(first.status).toBe(303);expect(second.headers.get('location')).toBe(first.headers.get('location'));
 const invite=new URL(first.headers.get('location')!).searchParams.get('invite')!;
 const registry=createPilotInstallationRegistry(namespace as typeof env.PILOT_INSTALLATIONS);
 expect(await registry.getInvite(invite)).toMatchObject({customerWorkspaceId:workspaceId});
 const entry=await worker.fetch(new Request(first.headers.get('location')!),effective);expect(entry.status).toBe(303);
 const signup=await worker.fetch(new Request(entry.headers.get('location')!,{headers:{cookie:entry.headers.get('set-cookie')!.split(';')[0]}}),effective);expect(signup.status).toBe(200);expect(await signup.text()).toContain('Morning Premium');
 const wrong=await worker.fetch(new Request(url.replace(workspaceId,'prem-other'),{method:'POST',headers:{...headers,origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf})}),effective);expect(wrong.status).toBe(409);
});
