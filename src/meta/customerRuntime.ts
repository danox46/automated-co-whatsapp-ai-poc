import {z} from 'zod';
import {readBearerToken,type WhatsAppMcpTokenVerifier} from '../mcp/auth.js';
import type {DurableConversationNamespace} from '../mcp/durableConversationStore.js';
import type {createPilotInstallationRegistry} from './pilotInstallationStore.js';
import {opaqueInstallationRef} from './installationIdentity.js';
import {dispatchFreeFormReply,type WhatsAppMessagingCapability} from '../mcp/outboundPolicy.js';
import {sha256Base64Url} from './pilotCrypto.js';

export const customerRuntimeReport=z.object({revision:z.number().int().positive(),enabled:z.boolean(),offlineMessage:z.string().max(2000)}).strict();
export type CustomerRuntimeReport=z.infer<typeof customerRuntimeReport>;
export type StoredCustomerRuntime=CustomerRuntimeReport&{subject:string;installationBinding:string;lastSeenAt:number;generation:string};
export const CUSTOMER_RUNTIME_STALE_MS=90000;
export function updateCustomerRuntime(previous:StoredCustomerRuntime|null,report:CustomerRuntimeReport,subject:string,installationBinding:string,now:number):StoredCustomerRuntime{
 const value=customerRuntimeReport.parse(report);
 if(previous?.installationBinding===installationBinding&&(value.revision<previous.revision||value.revision===previous.revision&&value.offlineMessage!==previous.offlineMessage))throw Error('RUNTIME_SETTINGS_CONFLICT');
 const changed=!previous||previous.installationBinding!==installationBinding||previous.revision!==value.revision||previous.enabled!==value.enabled||previous.offlineMessage!==value.offlineMessage||previous.subject!==subject;
 if(!changed&&now-previous.lastSeenAt<60000)return previous;
 const generation=!previous||now-previous.lastSeenAt>CUSTOMER_RUNTIME_STALE_MS||changed?crypto.randomUUID():previous.generation;
 return {...value,subject,installationBinding,lastSeenAt:now,generation};
}
export function runtimeIsOffline(value:StoredCustomerRuntime|null,now:number):value is StoredCustomerRuntime{
 return !!value&&value.enabled&&!!value.offlineMessage.trim()&&now-value.lastSeenAt>CUSTOMER_RUNTIME_STALE_MS;
}
type Dependencies={conversations:DurableConversationNamespace;registry:ReturnType<typeof createPilotInstallationRegistry>;resource:string;secret:string;verifyToken?:WhatsAppMcpTokenVerifier;messaging?:WhatsAppMessagingCapability;now?:()=>number};
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
export function createCustomerRuntime(input:Dependencies){
 const now=input.now??Date.now;
 const binding=async(tenantId:string)=>{const installation=await input.registry.getInstallation(tenantId);if(installation?.status!=='connected')return null;
  return (await opaqueInstallationRef(tenantId,installation.wabaId,installation.phoneNumberId,input.secret))+':'+installation.connectedAt;};
 const deliver=async(tenantId:string,conversationRef:string,occurredAt:string):Promise<'waiting'|'done'>=>{
   if(!input.messaging?.guaranteesDurableIdempotency)return 'done';
   const stub=input.conversations.getByName(tenantId),value=await stub.getCustomerRuntime();
   if(!value?.enabled||!value.offlineMessage.trim()||value.installationBinding!==await binding(tenantId))return 'done';
   const conversation=await stub.getConversationEnforcementState(conversationRef);
   if(!conversation||conversation.recipientOptedOut||conversation.automationPaused||conversation.lastOutboundAt&&Date.parse(conversation.lastOutboundAt)>=Date.parse(occurredAt)||now()-Date.parse(occurredAt)>=86400000)return 'done';
   if(!runtimeIsOffline(value,now()))return 'waiting';
   const idempotencyKey='offline_'+await sha256Base64Url(JSON.stringify([value.generation,conversationRef,value.revision]));
   await dispatchFreeFormReply(input.messaging,{subject:value.subject,tenantId,audience:input.resource,scopes:new Set(['whatsapp.messages.send'])},
    {conversationRef,text:value.offlineMessage,idempotencyKey,offlineRuntime:{generation:value.generation,revision:value.revision,inboundAt:occurredAt}});
   return 'done';
 };
 return {
  deliverPending:deliver,
  async fetch(request:Request):Promise<Response|null>{
   const url=new URL(request.url);if(url.pathname!=='/native/runtime')return null;
   const respond=(code:string,status:number)=>Response.json({ok:false,code},{status,headers});
   if(request.method!=='POST'||url.search)return respond('INVALID_RUNTIME_REQUEST',400);
   const token=readBearerToken(request),principal=token&&input.verifyToken?await input.verifyToken(token,request):null;
   if(!principal||principal.audience!==input.resource)return respond('RUNTIME_AUTH_REQUIRED',401);
   if(!principal.scopes.has('whatsapp.messages.send'))return respond('RUNTIME_SEND_PERMISSION_REQUIRED',403);
   if(!request.headers.get('content-type')?.startsWith('application/json'))return respond('INVALID_RUNTIME_REQUEST',400);
   const reader=request.body?.getReader();if(!reader)return respond('INVALID_RUNTIME_REQUEST',400);
   let bytes=0;const parts:Uint8Array[]=[];
   try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>16384){await reader.cancel();return respond('RUNTIME_REQUEST_TOO_LARGE',413);}parts.push(part.value);}}finally{reader.releaseLock();}
   const joined=new Uint8Array(bytes);let offset=0;for(const part of parts){joined.set(part,offset);offset+=part.length;}
   let raw:unknown;try{raw=JSON.parse(new TextDecoder().decode(joined));}catch{return respond('INVALID_RUNTIME_REQUEST',400);}
   const parsed=customerRuntimeReport.safeParse(raw);if(!parsed.success)return respond('INVALID_RUNTIME_REQUEST',400);
   const installationBinding=await binding(principal.tenantId);if(!installationBinding)return respond('RUNTIME_INSTALLATION_DISCONNECTED',409);
   const stub=input.conversations.getByName(principal.tenantId);await stub.initializeTenant(principal.tenantId);
   try{const value=await stub.reportCustomerRuntime(parsed.data,principal.subject,installationBinding,now());return Response.json({ok:true,revision:value.revision,enabled:value.enabled,reportedAt:value.lastSeenAt},{headers});}
   catch(error){if(error instanceof Error&&error.message.includes('RUNTIME_SETTINGS_CONFLICT'))return respond('RUNTIME_SETTINGS_CONFLICT',409);throw error;}
  },
  async inbound(tenantId:string,conversationRef:string,occurredAt:string){
   if(!input.messaging?.guaranteesDurableIdempotency)return;
   const stub=input.conversations.getByName(tenantId),value=await stub.getCustomerRuntime();
   if(!value?.enabled||!value.offlineMessage.trim()||Date.parse(occurredAt)+1000<value.lastSeenAt)return;
   await stub.queueCustomerOffline(conversationRef,occurredAt,now());
   try{if(await deliver(tenantId,conversationRef,occurredAt)==='done')await stub.completeCustomerOffline(conversationRef,occurredAt);}
   catch(error){await stub.completeCustomerOffline(conversationRef,occurredAt);throw error;}
  }
 };
}
