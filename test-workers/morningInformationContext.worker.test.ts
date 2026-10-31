import {env} from 'cloudflare:workers';
import {it,expect} from 'vitest';
import {createPersistentWhatsAppWorker,type PersistentWhatsAppWorkerEnv} from '../src/mcp/persistentWorker.js';
import {createPilotInstallationRegistry} from '../src/meta/pilotInstallationStore.js';
import {encryptPilotSecret} from '../src/meta/pilotCrypto.js';
import {premiumWorkspaceTenant} from '../src/oauth/morningSessions.js';
import {signRs256Jwt,verifyRs256Jwt} from '../src/oauth/jwt.js';
import {createDurableOAuthState} from '../src/oauth/durableAuthorizationStore.js';

it('actual Worker issues a verified sender assertion and honors token revocation',async()=>{
 const origin='https://pilot.test',morningIssuer='https://morning.fixture.test',workspaceId='ctx-'+crypto.randomUUID();
 const effective={...env,MORNING_ISSUER:morningIssuer} as unknown as PersistentWhatsAppWorkerEnv;
 const tenantId=await premiumWorkspaceTenant(morningIssuer,workspaceId),registry=createPilotInstallationRegistry(env.PILOT_INSTALLATIONS),stub=env.CONVERSATIONS.getByName(tenantId);
 const suffix=crypto.getRandomValues(new Uint32Array(1))[0].toString().padStart(10,'0'),phoneNumberId='900'+suffix,at=new Date().toISOString();
 await registry.refreshInstallation({tenantId,wabaId:'800'+suffix,phoneNumberId,encryptedAccessToken:await encryptPilotSecret('synthetic-provider-only',effective.INSTALLATION_ENCRYPTION_KEY!),connectedAt:at,webhookSubscribedAt:at,status:'connected'});
 await stub.initializeTenant(tenantId);const conversationRef='conv_'+crypto.randomUUID().replaceAll('-','');
 await stub.ingestMessage({conversationRef,providerAccountRef:phoneNumberId,providerParticipantRef:'15550003333',messageRef:'inbound-'+suffix,direction:'inbound',kind:'text',text:'Synthetic customer',occurredAt:at,status:'received'});
 const now=Math.floor(Date.now()/1000),jti='context-token-'+crypto.randomUUID(),token=await signRs256Jwt({alg:'RS256',kid:effective.OAUTH_SIGNING_KEY_ID!,typ:'at+jwt'},{iss:origin,aud:origin,sub:'native-context-fixture',tenant_id:tenantId,scope:'whatsapp.conversations.read',iat:now,nbf:now,exp:now+300,jti},JSON.parse(effective.OAUTH_SIGNING_PRIVATE_JWK!));
 const worker=createPersistentWhatsAppWorker(),request=()=>new Request(origin+'/native/morning-context',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({workspaceId,conversationRef})});
 const response=await worker.fetch(request(),effective);expect(response.status).toBe(200);
 const value=await response.json() as {assertion:string};const proof=await verifyRs256Jwt(value.assertion,async()=>JSON.parse(effective.OAUTH_SIGNING_PUBLIC_JWK!));
 expect(proof!.claims).toMatchObject({workspace_id:workspaceId,tenant_id:tenantId,sub:conversationRef,sender:'15550003333',aud:morningIssuer+'/extensions/worker'});
 await createDurableOAuthState(env.OAUTH_STATE).store.revokeAccessToken(jti,now+300);
 expect((await worker.fetch(request(),effective)).status).toBe(401);
});
