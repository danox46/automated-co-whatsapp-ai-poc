import {env} from 'cloudflare:workers';
import {runInDurableObject,runDurableObjectAlarm,evictDurableObject} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {createPersistentWhatsAppWorker,type PersistentWhatsAppWorkerEnv} from '../src/mcp/persistentWorker.js';
import {createPilotInstallationRegistry} from '../src/meta/pilotInstallationStore.js';
import {encryptPilotSecret} from '../src/meta/pilotCrypto.js';
import {createMetaGraphClient} from '../src/meta/graphClient.js';
import {createMetaMessagingCapability} from '../src/meta/messagingCapability.js';
import {opaqueConversationRef} from '../src/meta/conversationEvents.js';
import {opaqueInstallationRef} from '../src/meta/installationIdentity.js';

it('pausing retires pending replies before reactivation and clears an unused alarm',async()=>{
 const tenant='paused-'+crypto.randomUUID(),stub=env.CONVERSATIONS.getByName(tenant),now=Date.now();await stub.initializeTenant(tenant);
 const conversationRef='pause-conversation';
 await stub.ingestMessage({conversationRef,providerAccountRef:'15550001111',providerParticipantRef:'15550002222',messageRef:'pause-inbound',direction:'inbound',kind:'text',text:'Hello',occurredAt:new Date(now).toISOString(),status:'received'});
 await stub.reportCustomerRuntime({revision:1,enabled:true,offlineMessage:'Back soon'},'owner','installation',now);
 await stub.queueCustomerOffline(conversationRef,new Date(now).toISOString(),now);
 await stub.reportCustomerRuntime({revision:1,enabled:false,offlineMessage:'Back soon'},'owner','installation',now+1000);
 await stub.reportCustomerRuntime({revision:1,enabled:true,offlineMessage:'Back soon'},'owner','installation',now+2000);
 expect(await runInDurableObject(stub,async(_instance,state)=>({count:state.storage.sql.exec<{count:number}>('SELECT COUNT(*) AS count FROM customer_offline_pending').one().count,alarm:await state.storage.getAlarm()}))).toEqual({count:0,alarm:null});
});

for(const outcome of ['reply','online','answered','paused','handoff','disconnected','uncertain'] as const)it(`durable delayed inbound check survives eviction: ${outcome}`,async()=>{
 const tenantId='alarm-'+crypto.randomUUID(),stub=env.CONVERSATIONS.getByName(tenantId),registry=createPilotInstallationRegistry(env.PILOT_INSTALLATIONS),effective=env as unknown as PersistentWhatsAppWorkerEnv;
 const suffix=crypto.getRandomValues(new Uint32Array(1))[0].toString().padStart(10,'0'),wabaId='800'+suffix,phoneNumberId='900'+suffix,conversationRef='conv_'+crypto.randomUUID().replaceAll('-','');
 const start=Date.now(),occurredAt=new Date(start).toISOString(),connectedAt=occurredAt;
 const installation={tenantId,wabaId,phoneNumberId,encryptedAccessToken:await encryptPilotSecret('synthetic-provider-token',effective.INSTALLATION_ENCRYPTION_KEY!),connectedAt,webhookSubscribedAt:connectedAt,status:'connected' as const};
 await registry.refreshInstallation(installation);await stub.initializeTenant(tenantId);
 const binding=(await opaqueInstallationRef(tenantId,wabaId,phoneNumberId,effective.CONVERSATION_REF_SECRET))+':'+connectedAt;
 await stub.reportCustomerRuntime({revision:1,enabled:true,offlineMessage:'Back soon'},'owner',binding,start);
 await stub.ingestMessage({conversationRef,providerAccountRef:phoneNumberId,providerParticipantRef:'15550003333',messageRef:'inbound-'+suffix,direction:'inbound',kind:'text',text:'Hello',occurredAt,status:'received'});
 await stub.configureRetention({messageRetentionDays:90,inactiveConversationRetentionDays:365,pendingStatusRetentionDays:7,pruneIntervalHours:24},occurredAt);
 await stub.queueCustomerOffline(conversationRef,occurredAt,start);
 const due=await runInDurableObject(stub,async(_instance,state)=>state.storage.getAlarm());expect(due).toBe(start+90001);
 await evictDurableObject(stub);
 if(outcome==='online')await stub.reportCustomerRuntime({revision:1,enabled:true,offlineMessage:'Back soon'},'owner',binding,start+100000);
 if(outcome==='paused')await stub.reportCustomerRuntime({revision:1,enabled:false,offlineMessage:'Back soon'},'owner',binding,start+100000);
 if(outcome==='handoff')await stub.updatePolicyState({conversationRef,automationPaused:true,policyRevision:'human'});
 if(outcome==='answered')await stub.ingestMessage({conversationRef,providerAccountRef:phoneNumberId,providerParticipantRef:'15550003333',messageRef:'reply-'+suffix,direction:'outbound',kind:'text',text:'Answered',occurredAt:new Date(start+5000).toISOString(),status:'sent'});
 if(outcome==='disconnected')await registry.refreshInstallation({...installation,status:'disconnected'});
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(start+120000);
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
  expect(String(url)).toBe(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`);
  expect(JSON.parse(String(init?.body)).text.body).toBe('Back soon');
  if(outcome==='uncertain')throw Error('provider outcome unknown');
  return Response.json({messages:[{id:'wamid.delayed-'+suffix}]});
 });
 try{
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(outcome==='reply'||outcome==='uncertain'?1:0);
  const state=await runInDurableObject(stub,async(_instance,state)=>({pending:state.storage.sql.exec<{count:number}>('SELECT COUNT(*) AS count FROM customer_offline_pending').one().count,alarm:await state.storage.getAlarm(),retention:state.storage.sql.exec("SELECT value FROM metadata WHERE key='retention_last_run_at'").toArray(),issue:state.storage.sql.exec("SELECT value FROM metadata WHERE key='customer_runtime_last_issue'").toArray()}));
  expect(state.pending).toBe(outcome==='online'?1:0);expect(state.retention).toEqual([]);
  expect(state.alarm).toBe(outcome==='online'?start+190001:start+86400000);
  if(outcome==='uncertain')expect(state.issue).toHaveLength(1);
  if(outcome==='reply'||outcome==='uncertain'){
   await stub.queueCustomerOffline(conversationRef,occurredAt,start);
   await runInDurableObject(stub,async(instance,state)=>{state.storage.sql.exec('UPDATE customer_offline_pending SET due_at=?',start);await instance.alarm()});
   expect(fetch).toHaveBeenCalledTimes(1);
  }
 }finally{fetch.mockRestore();vi.useRealTimers();}
});

it('accepts an authenticated runtime report for its connected installation only',async()=>{
 const tenantId='runtime-'+crypto.randomUUID(),registry=createPilotInstallationRegistry(env.PILOT_INSTALLATIONS);
 const suffix=crypto.getRandomValues(new Uint32Array(1))[0].toString().padStart(10,'0');
 await registry.refreshInstallation({tenantId,wabaId:'800'+suffix,phoneNumberId:'900'+suffix,
  encryptedAccessToken:{version:1,iv:'synthetic',ciphertext:'synthetic'},connectedAt:new Date().toISOString(),webhookSubscribedAt:new Date().toISOString(),status:'connected'});
 const worker=createPersistentWhatsAppWorker({verifyToken:async token=>token==='test-runtime-token'?{subject:'owner',tenantId,audience:'https://pilot.test',scopes:new Set(['whatsapp.messages.send'])}:null});
 const call=(body:unknown,authenticated=true)=>worker.fetch(new Request('https://pilot.test/native/runtime',{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:'Bearer test-runtime-token'}:{})},body:JSON.stringify(body)}),env as unknown as PersistentWhatsAppWorkerEnv);
 expect((await call({revision:1,enabled:true,offlineMessage:'We will reply shortly.'})).status).toBe(200);
 expect((await call({revision:1,enabled:true,offlineMessage:'We will reply shortly.'},false)).status).toBe(401);
 expect((await call({revision:1,enabled:true,offlineMessage:'We will reply shortly.',tenantId:'other'})).status).toBe(400);
 expect((await call({revision:1,enabled:true,offlineMessage:'Conflicting configuration'})).status).toBe(409);
 const stored=await env.CONVERSATIONS.getByName(tenantId).getCustomerRuntime();expect(stored).toMatchObject({revision:1,enabled:true,offlineMessage:'We will reply shortly.',subject:'owner'});
 expect((await call({revision:1,enabled:false,offlineMessage:'We will reply shortly.'})).status).toBe(200);
 expect(await env.CONVERSATIONS.getByName(tenantId).getCustomerRuntime()).toMatchObject({enabled:false});
});

for(const uncertain of [false,true])it(`signed inbound uses durable offline reply policy (${uncertain?'uncertain outcome':'accepted'})`,async()=>{
 const tenantId='inbound-'+crypto.randomUUID(),registry=createPilotInstallationRegistry(env.PILOT_INSTALLATIONS),effective=env as unknown as PersistentWhatsAppWorkerEnv;
 const suffix=crypto.getRandomValues(new Uint32Array(1))[0].toString().padStart(10,'0'),wabaId='800'+suffix,phoneNumberId='900'+suffix,participant='15550003333';
 const connectedAt=new Date().toISOString();
 await registry.refreshInstallation({tenantId,wabaId,phoneNumberId,encryptedAccessToken:await encryptPilotSecret('synthetic-provider-token',effective.INSTALLATION_ENCRYPTION_KEY!),connectedAt,webhookSubscribedAt:connectedAt,status:'connected'});
 let sends=0;
 const graph=createMetaGraphClient({appId:'test',appSecret:'test',graphVersion:'v25.0',fetch:async(_url,init)=>{sends++;expect(JSON.parse(String(init?.body)).text.body).toBe('Back soon');if(uncertain)throw Error('connection interrupted');return Response.json({messages:[{id:'wamid.offline-fixture'}]});}});
 const messaging=createMetaMessagingCapability({conversations:env.CONVERSATIONS,registry,graph,encryptionKey:effective.INSTALLATION_ENCRYPTION_KEY!});
 const worker=createPersistentWhatsAppWorker({messaging,verifyToken:async()=>({subject:'owner',tenantId,audience:'https://pilot.test',scopes:new Set(['whatsapp.messages.send'])})});
 let revision=1;
 const report=(enabled:boolean)=>worker.fetch(new Request('https://pilot.test/native/runtime',{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:JSON.stringify({revision,enabled,offlineMessage:'Back soon'})}),effective);
 expect((await report(true)).status).toBe(200);
 const stub=env.CONVERSATIONS.getByName(tenantId),current=await stub.getCustomerRuntime();
 const inbound=async(id:string,signatureValid=true,ageMs=0)=>{
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:phoneNumberId},messages:[{id,from:participant,timestamp:String(Math.floor((Date.now()-ageMs)/1000)),type:'text',text:{body:'Hello'}}]}}]}]});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(effective.META_APP_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))),byte=>byte.toString(16).padStart(2,'0')).join('');
  return worker.fetch(new Request('https://pilot.test/webhooks/meta/whatsapp',{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':'sha256='+(signatureValid?signature:'0'.repeat(64))},body}),effective);
 };
 expect((await inbound('online-message')).status).toBe(200);expect(sends).toBe(0);
 expect(await runInDurableObject(stub,async(_instance,state)=>state.storage.sql.exec<{count:number}>('SELECT COUNT(*) AS count FROM customer_offline_pending').one().count)).toBe(1);
 revision=2;await stub.reportCustomerRuntime({revision,enabled:true,offlineMessage:'Back soon'},'owner',current!.installationBinding,Date.now()-100000);
 expect((await inbound('invalid-signature',false)).status).toBe(401);expect(sends).toBe(0);
 expect((await inbound('delayed-message',true,150000)).status).toBe(200);expect(sends).toBe(0);
 const conversationRef=await opaqueConversationRef(tenantId,phoneNumberId,participant,effective.CONVERSATION_REF_SECRET);
 await stub.updatePolicyState({conversationRef,automationPaused:true,policyRevision:'human'});
 expect((await inbound('human-owned-message')).status).toBe(200);expect(sends).toBe(0);
 await stub.updatePolicyState({conversationRef,automationPaused:false,policyRevision:'bot'});
 const simultaneous=await Promise.all([inbound('offline-message'),inbound('offline-message')]);
 expect(simultaneous.map(response=>response.status).sort()).toEqual(uncertain?[200,503]:[200,200]);expect(sends).toBe(1);
 expect((await inbound('offline-message')).status).toBe(200);
 expect((await inbound('another-message')).status).toBe(200);expect(sends).toBe(1);
 expect((await report(false)).status).toBe(200);
 expect((await inbound('after-pause')).status).toBe(200);expect(sends).toBe(1);
});

it('checks offline runtime state atomically when reserving a reply',async()=>{
 const tenant='offline-'+crypto.randomUUID(),stub=env.CONVERSATIONS.getByName(tenant);await stub.initializeTenant(tenant);
 const now=Date.now(),conversationRef='conv_'+ 'b'.repeat(32);
 await stub.ingestMessage({conversationRef,providerAccountRef:'15550001111',providerParticipantRef:'15550002222',messageRef:'inbound-test',direction:'inbound',kind:'text',text:'Hello',occurredAt:new Date(now).toISOString(),status:'received'});
 const initial=await stub.reportCustomerRuntime({revision:1,enabled:true,offlineMessage:'Back soon'},'owner','installation',now-100000);
 const state=await stub.getConversationEnforcementState(conversationRef);
 const reservation={conversationRef,kind:'free_form_reply' as const,idempotencyKey:'offline-test-key',requestFingerprint:'a'.repeat(43),expectedPolicyRevision:state!.policyRevision,now:new Date(now).toISOString(),notAfter:new Date(now+60000).toISOString(),offlineRuntime:{generation:initial.generation,revision:1,inboundAt:new Date(now).toISOString()}};
 await stub.reportCustomerRuntime({revision:1,enabled:true,offlineMessage:'Back soon'},'owner','installation',now);
 expect(await stub.reserveOutboundDispatch(reservation)).toMatchObject({status:'blocked',reason:'state_changed'});
});
