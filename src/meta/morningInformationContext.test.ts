import {beforeAll,describe,it,expect,vi} from 'vitest';
import {createMorningInformationContext} from './morningInformationContext.js';
import {premiumWorkspaceTenant} from '../oauth/morningSessions.js';
import {verifyRs256Jwt} from '../oauth/jwt.js';
import type {WhatsAppMcpPrincipal} from '../mcp/auth.js';
import type {InternalConversationEnforcementState} from '../mcp/conversationHistory.js';

const resource='https://whatsapp.example.test',morningIssuer='https://morning.example.test',workspaceId='customer-workspace',conversationRef='conv_'+'a'.repeat(32),now=Date.parse('2026-10-31T17:00:00Z');
let privateJwk:JsonWebKey,publicJwk:JsonWebKey,tenantId:string;
beforeAll(async()=>{
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);publicJwk=await crypto.subtle.exportKey('jwk',pair.publicKey);tenantId=await premiumWorkspaceTenant(morningIssuer,workspaceId);
});
function fixture(){
 const principal:WhatsAppMcpPrincipal={subject:'native-runtime',tenantId,audience:resource,scopes:new Set(['whatsapp.conversations.read'])};
 const state:InternalConversationEnforcementState={conversationRef,providerAccountRef:'synthetic-number-id',providerParticipantRef:'584141234567',lastVerifiedUserInboundAt:new Date(now-60000).toISOString(),recipientOptedOut:false,automationPaused:false,policyRevision:'1'};
 const verifyToken=vi.fn(async()=>principal as WhatsAppMcpPrincipal|null),installation=vi.fn(async()=>({status:'connected',phoneNumberId:'synthetic-number-id'} as {status:string;phoneNumberId:string}|null)),enforcement=vi.fn(async()=>state as InternalConversationEnforcementState|null);
 const handler=createMorningInformationContext({resource,morningIssuer,signingKey:{kid:'fixture',privateJwk},verifyToken,installation,enforcement,now:()=>now});
 const request=(body:unknown={workspaceId,conversationRef},extra:RequestInit={})=>new Request(resource+'/native/morning-context',{method:'POST',headers:{authorization:'Bearer synthetic-auth', 'content-type':'application/json'},body:JSON.stringify(body),...extra});
 return {handler,principal,state,verifyToken,installation,enforcement,request};
}
describe('verified Morning conversation context',()=>{
 it('signs only the stored sender for the fixed Morning audience and workspace',async()=>{
  const f=fixture(),response=await f.handler.fetch(f.request());expect(response!.status).toBe(200);expect(response!.headers.get('cache-control')).toBe('no-store');
  const body=await response!.json() as {assertion:string;expiresAt:number};expect(Object.keys(body).sort()).toEqual(['assertion','expiresAt']);
  const verified=await verifyRs256Jwt(body.assertion,async()=>publicJwk);expect(verified!.claims).toMatchObject({iss:resource,aud:morningIssuer+'/extensions/worker',sub:conversationRef,workspace_id:workspaceId,tenant_id:tenantId,sender:'584141234567',purpose:'morning-bot-information',iat:now/1000,exp:now/1000+60});
  expect(f.enforcement).toHaveBeenCalledWith(tenantId,conversationRef);expect(body.expiresAt).toBe(now+60000);
 });
 it('requires current provider auth and conversation-read permission',async()=>{
  const f=fixture();f.verifyToken.mockResolvedValue(null);expect((await f.handler.fetch(f.request()))!.status).toBe(401);expect(f.enforcement).not.toHaveBeenCalled();
  f.verifyToken.mockResolvedValue({...f.principal,scopes:new Set()});expect((await f.handler.fetch(f.request()))!.status).toBe(403);
  f.verifyToken.mockResolvedValue({...f.principal,audience:'https://foreign.test'});expect((await f.handler.fetch(f.request()))!.status).toBe(401);
 });
 it('rejects foreign workspaces, caller-supplied phone and arbitrary audience',async()=>{
  const f=fixture();expect((await f.handler.fetch(f.request({workspaceId:'other',conversationRef})))!.status).toBe(403);
  for(const extra of [{sender:'584141234599'},{customerId:'bob'},{audience:'https://foreign.test'},{tenantId}])expect((await f.handler.fetch(f.request({workspaceId,conversationRef,...extra})))!.status).toBe(400);
  expect(f.enforcement).not.toHaveBeenCalled();
 });
 it('checks connected installation and the same provider account every call',async()=>{
  const f=fixture();expect((await f.handler.fetch(f.request()))!.status).toBe(200);f.installation.mockResolvedValue({status:'disconnected',phoneNumberId:'synthetic-number-id'});expect((await f.handler.fetch(f.request()))!.status).toBe(403);
  f.installation.mockResolvedValue({status:'connected',phoneNumberId:'reconnected-number'});expect((await f.handler.fetch(f.request()))!.status).toBe(403);
 });
 it('requires genuine inbound context and respects current handoff and opt out',async()=>{
  const f=fixture();for(const state of [null,{...f.state,conversationRef:'conv_'+'b'.repeat(32)},{...f.state,lastVerifiedUserInboundAt:undefined},{...f.state,providerParticipantRef:'forged phone'},{...f.state,automationPaused:true},{...f.state,recipientOptedOut:true}]){
   f.enforcement.mockResolvedValue(state);const result=await f.handler.fetch(f.request());expect(result!.status).toBe(403);expect(await result!.text()).not.toContain('584141234567');
  }
 });
 it('bounds request input and ignores other routes',async()=>{
  const f=fixture();expect(await f.handler.fetch(new Request(resource+'/mcp'))).toBeNull();expect((await f.handler.fetch(f.request({}, {method:'GET',body:undefined})))!.status).toBe(400);
  expect((await f.handler.fetch(f.request({workspaceId,conversationRef,padding:'x'.repeat(3000)})))!.status).toBe(413);
 });
 it('contains dependency failures without exposing their bodies',async()=>{
  const f=fixture();f.enforcement.mockRejectedValue(Error('private sender 584141234567'));const result=await f.handler.fetch(f.request());expect(result!.status).toBe(503);expect(await result!.text()).not.toContain('584141234567');
 });
});
