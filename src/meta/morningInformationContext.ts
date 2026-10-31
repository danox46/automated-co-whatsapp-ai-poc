import {z} from 'zod';
import {readBearerToken,type WhatsAppMcpTokenVerifier} from '../mcp/auth.js';
import type {InternalConversationEnforcementState} from '../mcp/conversationHistory.js';
import {premiumWorkspaceTenant} from '../oauth/morningSessions.js';
import {signRs256Jwt} from '../oauth/jwt.js';

const inputSchema=z.object({workspaceId:z.string().regex(/^[a-z0-9-]{1,100}$/u),conversationRef:z.string().regex(/^conv_[A-Za-z0-9_-]{32}$/u)}).strict();
const headers={'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
type Options={resource:string;morningIssuer:string;signingKey:{kid:string;privateJwk:JsonWebKey};verifyToken:WhatsAppMcpTokenVerifier;
 installation:(tenantId:string)=>Promise<{status:string;phoneNumberId:string}|null>;
 enforcement:(tenantId:string,conversationRef:string)=>Promise<InternalConversationEnforcementState|null>;now?:()=>number};

/** Native-host exchange, not an LLM tool. The host keeps the assertion opaque
 * and uses it only with its separately enrolled Morning device connection. */
export function createMorningInformationContext(options:Options){
 for(const origin of [options.resource,options.morningIssuer]){const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin)throw Error('Exact HTTPS context origins required');}
 return {async fetch(request:Request):Promise<Response|null>{
  const url=new URL(request.url);if(url.pathname!=='/native/morning-context')return null;
  const deny=(code:string,status:number)=>Response.json({ok:false,code},{status,headers});
  if(url.origin!==options.resource||request.method!=='POST'||url.search)return deny('INVALID_CONTEXT_REQUEST',400);
  try{
   const bearer=readBearerToken(request),principal=bearer?await options.verifyToken(bearer,request):null;
   if(!principal||principal.audience!==options.resource)return deny('CONTEXT_AUTH_REQUIRED',401);
   if(!principal.scopes.has('whatsapp.conversations.read'))return deny('CONTEXT_PERMISSION_REQUIRED',403);
   if(!request.headers.get('content-type')?.startsWith('application/json'))return deny('INVALID_CONTEXT_REQUEST',400);
   const reader=request.body?.getReader();if(!reader)return deny('INVALID_CONTEXT_REQUEST',400);
   let length=0;const parts:Uint8Array[]=[];
   try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>2048){await reader.cancel();return deny('CONTEXT_REQUEST_TOO_LARGE',413);}parts.push(part.value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
   let raw:unknown;try{raw=JSON.parse(new TextDecoder().decode(bytes));}catch{return deny('INVALID_CONTEXT_REQUEST',400);}
   const parsed=inputSchema.safeParse(raw);if(!parsed.success)return deny('INVALID_CONTEXT_REQUEST',400);
   const {workspaceId,conversationRef}=parsed.data;
   if(principal.tenantId!==await premiumWorkspaceTenant(options.morningIssuer,workspaceId))return deny('CONTEXT_UNAVAILABLE',403);
   const installation=await options.installation(principal.tenantId);if(installation?.status!=='connected')return deny('CONTEXT_UNAVAILABLE',403);
   const state=await options.enforcement(principal.tenantId,conversationRef),now=options.now?.()??Date.now();
   if(!state||state.conversationRef!==conversationRef||state.providerAccountRef!==installation.phoneNumberId||state.automationPaused||state.recipientOptedOut||
    !/^[1-9][0-9]{7,14}$/u.test(state.providerParticipantRef)||!state.lastVerifiedUserInboundAt||!Number.isFinite(Date.parse(state.lastVerifiedUserInboundAt))||Date.parse(state.lastVerifiedUserInboundAt)>now+5000)return deny('CONTEXT_UNAVAILABLE',403);
   const iat=Math.floor(now/1000),exp=iat+60;
   const assertion=await signRs256Jwt({alg:'RS256',kid:options.signingKey.kid,typ:'JWT'},
    {iss:options.resource,aud:options.morningIssuer+'/extensions/worker',sub:conversationRef,workspace_id:workspaceId,tenant_id:principal.tenantId,
     sender:state.providerParticipantRef,purpose:'morning-bot-information',iat,nbf:iat,exp,jti:crypto.randomUUID()},options.signingKey.privateJwk);
   return Response.json({assertion,expiresAt:exp*1000},{headers});
  }catch{return deny('CONTEXT_TEMPORARILY_UNAVAILABLE',503);}
 }};
}
