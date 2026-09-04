import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperatorSettingsManager } from "./operatorSettings.js";
let root:string|undefined;afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true})});
describe("operator settings",()=>{it("keeps the last valid handoff message when a reload is invalid",async()=>{root=await mkdtemp(join(tmpdir(),"settings-"));const path=join(root,"settings.json"),manager=new OperatorSettingsManager(path);await manager.start();await writeFile(path,JSON.stringify({handoffMessage:"Mensaje aprobado"}));expect((await manager.reload()).ok).toBe(true);await writeFile(path,"not json");expect((await manager.reload()).ok).toBe(false);expect(manager.current.handoffMessage).toBe("Mensaje aprobado");manager.stop()})});
