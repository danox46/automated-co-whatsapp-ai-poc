import { describe, expect, it, vi } from "vitest";
import { createTwilioSignatureMiddleware, resolveWebhookUrl } from "./signatureValidation.js";

function response(){return{code:200,body:undefined as unknown,status(code:number){this.code=code;return this},json(body:unknown){this.body=body;return this},send(body:unknown){this.body=body;return this}}}
describe("Twilio signature validation",()=>{
  it("fails closed when credentials are absent",()=>{const res=response(),next=vi.fn();createTwilioSignatureMiddleware({})( {header:()=>undefined} as never,res as never,next);expect(res.code).toBe(503);expect(next).not.toHaveBeenCalled()});
  it("passes the exact public webhook URL and form body to the SDK",()=>{const validate=vi.fn(()=>true),next=vi.fn(),res=response();const req={header:(name:string)=>name==="x-twilio-signature"?"sig":undefined,originalUrl:"/webhooks/twilio/whatsapp",body:{MessageSid:"SM1"},protocol:"http",get:()=>"localhost"};createTwilioSignatureMiddleware({authToken:"token",publicUrl:"https://bot.example.com"},validate as never)(req as never,res as never,next);expect(validate).toHaveBeenCalledWith("token","sig","https://bot.example.com/webhooks/twilio/whatsapp",req.body);expect(next).toHaveBeenCalledOnce()});
  it("honors the configured callback path",()=>{const req={originalUrl:"/webhooks/twilio/status",header:()=>undefined,protocol:"http",get:()=>"localhost"};expect(resolveWebhookUrl(req as never,"https://bot.example.com/webhooks/twilio/status")).toBe("https://bot.example.com/webhooks/twilio/status")});
});
