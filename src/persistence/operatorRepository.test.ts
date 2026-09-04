import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOperatorDatabase } from "./database.js";
import { OperatorRepository, ServiceWindowClosedError } from "./operatorRepository.js";

let root:string,repo:OperatorRepository,close:()=>void;
const now=new Date("2026-09-03T18:00:00.000Z");
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"operator-inbox-"));const db=openOperatorDatabase(join(root,"inbox.sqlite"));repo=new OperatorRepository(db,()=>now);close=()=>db.close()});
afterEach(async()=>{close();await rm(root,{recursive:true,force:true})});
function inbound(overrides:Record<string,unknown>={}){return repo.ingestInbound({provider:"twilio_whatsapp",providerMessageId:"SM1",from:"whatsapp:+573001234567",body:"Hola",profileName:"Nombre público",waId:"573001234567",receivedAt:now.toISOString(),raw:{},...overrides})}

describe("operator repository",()=>{
  it("runs migrations and persists public WhatsApp identity",()=>{const row=inbound();const chat=repo.getConversation(row.conversationId)!;expect(chat.publicProfileName).toBe("Nombre público");expect(chat.waId).toBe("573001234567")});
  it("gives a local alias display precedence without deleting the public name",()=>{const row=inbound();repo.setAlias(row.contactId,"Cliente VIP");const chat=repo.getConversation(row.conversationId)!;expect(chat.displayName).toBe("Cliente VIP");expect(chat.publicProfileName).toBe("Nombre público")});
  it("deduplicates provider retries and increments unread only once",()=>{const first=inbound(),second=inbound();expect(first.created).toBe(true);expect(second.created).toBe(false);expect(repo.getConversation(first.conversationId)?.unreadCount).toBe(1);expect(repo.getMessages(first.conversationId)).toHaveLength(1)});
  it("switches media-only inbound conversations to human mode",()=>{const row=inbound({body:"",media:[{index:0,url:"https://api.twilio.com/file",contentType:"image/png"}]});expect(repo.getConversation(row.conversationId)?.mode).toBe("human");expect(row.mediaIds).toHaveLength(1)});
  it("changes read and automation states explicitly",()=>{const row=inbound();repo.markRead(row.conversationId,true);repo.setMode(row.conversationId,"human");expect(repo.getConversation(row.conversationId)).toMatchObject({unreadCount:0,mode:"human"});repo.setMode(row.conversationId,"bot");expect(repo.getConversation(row.conversationId)?.mode).toBe("bot")});
  it("atomically enters human mode before an operator reply",()=>{const row=inbound();repo.createOutboundMessage({conversationId:row.conversationId,body:"Te ayudo",author:"operator"});expect(repo.getConversation(row.conversationId)?.mode).toBe("human");expect(repo.getMessages(row.conversationId).at(-1)?.author).toBe("operator")});
  it("enforces the 24-hour service window",()=>{const row=inbound({receivedAt:"2026-09-01T10:00:00.000Z"});expect(()=>repo.createOutboundMessage({conversationId:row.conversationId,body:"Fuera de ventana",author:"operator"})).toThrow(ServiceWindowClosedError)});
  it("deletes a conversation and its contact while returning media paths",()=>{const row=inbound({body:"",media:[{index:0,url:"https://api.twilio.com/file",contentType:"image/png"}]});repo.updateMedia(row.mediaIds[0],{status:"ready",localPath:join(root,"asset.png")});expect(repo.deleteConversation(row.conversationId)).toEqual([join(root,"asset.png")]);expect(repo.getConversation(row.conversationId)).toBeUndefined()});
});
