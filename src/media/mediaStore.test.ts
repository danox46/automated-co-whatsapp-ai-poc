import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertWithinRoot, deleteStoredMedia, downloadTwilioMedia, sanitizeFilename } from "./mediaStore.js";

let root:string|undefined;afterEach(async()=>{vi.unstubAllGlobals();if(root)await rm(root,{recursive:true,force:true});root=undefined});
const media={id:"opaque-id",messageId:"m",providerUrl:"https://api.twilio.com/media/1",contentType:"image/png",byteSize:null,originalFilename:null,localPath:null,status:"pending" as const,errorMessage:null};
describe("received media storage",()=>{
  it("uses authenticated Twilio downloads and opaque local names",async()=>{root=await mkdtemp(join(tmpdir(),"media-"));const fetchMock=vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]),{headers:{"content-type":"image/png","content-disposition":"inline; filename=photo.png"}}));vi.stubGlobal("fetch",fetchMock);const saved=await downloadTwilioMedia(media,{accountSid:"AC123",authToken:"secret",mediaRoot:root});expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /);expect(saved.localPath).toBe(resolve(root,"opaque-id.png"));expect(await readFile(saved.localPath)).toEqual(Buffer.from([1,2,3]))});
  it("rejects non-Twilio sources and unsupported types",async()=>{await expect(downloadTwilioMedia({...media,providerUrl:"https://example.com/a"},{accountSid:"a",authToken:"b",mediaRoot:"x"})).rejects.toThrow("outside Twilio");await expect(downloadTwilioMedia({...media,contentType:"text/html"},{accountSid:"a",authToken:"b",mediaRoot:"x"})).rejects.toThrow("Unsupported")});
  it("rejects unsafe paths and sanitizes names",()=>{expect(()=>assertWithinRoot("C:/safe","C:/outside/a")).toThrow("Unsafe");expect(sanitizeFilename("../bad:name?.pdf")).toBe("bad_name_.pdf")});
  it("removes only files inside the media root",async()=>{root=await mkdtemp(join(tmpdir(),"media-"));const file=join(root,"one.png");await writeFile(file,"x");await deleteStoredMedia([file],root);await expect(readFile(file)).rejects.toThrow()});
});
