import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config/env.js";
import { openOperatorDatabase } from "../persistence/database.js";
import { OperatorRepository } from "../persistence/operatorRepository.js";

type DemoChat={phone:string;name:string;alias?:string;mode?:"human"|"bot";hoursAgo:number;lines:Array<["customer"|"bot"|"operator",string]>;unread?:boolean;media?:boolean};
const chats:DemoChat[]=[
  {phone:"whatsapp:+573001234567",name:"Valentina Rojas",alias:"Vale · Café Aurora",mode:"human",hoursAgo:1,unread:true,lines:[["customer","Hola, la máquina llegó pero creo que falta una pieza."],["bot","Gracias por escribirnos. Voy a revisar contigo qué pieza puede faltar."],["customer","Te mando una foto de lo que llegó." ]],media:true},
  {phone:"whatsapp:+573107654321",name:"Mateo Gómez",hoursAgo:2,lines:[["customer","¿Tienen el molino Compact disponible?"],["bot","Sí, el Compact está disponible. ¿Lo buscas para casa o para negocio?"]] },
  {phone:"whatsapp:+573159876543",name:"Sofía Martínez",mode:"human",hoursAgo:3,unread:true,lines:[["customer","Necesito ayuda con una garantía."],["bot","Voy a pasar tu conversación a una persona del equipo. La respuesta puede tardar un poco, pero tu mensaje quedó registrado y no lo vamos a perder."]] },
  {phone:"whatsapp:+573204445555",name:"Carlos Jiménez",hoursAgo:6,lines:[["customer","Muchas gracias por la asesoría."],["operator","Con gusto, Carlos. Aquí estamos para ayudarte."]] },
  {phone:"whatsapp:+573118889999",name:"Laura Torres",hoursAgo:22,lines:[["customer","¿Cuál cafetera recomiendan para dos personas?"],["bot","La Mini Brew es una excelente opción para dos personas y espacios pequeños."]] },
  {phone:"whatsapp:+573005551111",name:"Andrés Pérez",hoursAgo:52,lines:[["customer","Quedó pendiente la guía de uso."],["bot","Claro, te la compartimos por este mismo chat."]] }
];

export async function seedOperatorDemo(){
  const config=loadConfig(),database=openOperatorDatabase(config.operator.databasePath),repository=new OperatorRepository(database);
  if(repository.getMeta("operator_demo_v1")){database.close();return}
  for(const [chatIndex,chat] of chats.entries()){
    let conversationId="",contactId="";
    for(const [lineIndex,[author,body]] of chat.lines.entries()){
      const at=new Date(Date.now()-chat.hoursAgo*3600000+lineIndex*60000).toISOString();
      if(author==="customer"){
        const result=repository.ingestInbound({provider:"twilio_whatsapp",providerMessageId:`DEMO_${chatIndex}_${lineIndex}`,from:chat.phone,body,profileName:chat.name,waId:chat.phone.replace(/\D/g,""),receivedAt:at,raw:{demo:true},media:chat.media&&lineIndex===2?[{index:0,url:"https://api.twilio.com/demo-media",contentType:"image/png"}]:[]});
        conversationId=result.conversationId;contactId=result.contactId;
        if(chat.media&&lineIndex===2){const target=resolve(config.operator.mediaPath,`${result.mediaIds[0]}.png`);await mkdir(config.operator.mediaPath,{recursive:true});await copyFile(resolve("operator-ui/public/assets/coffee-machine-demo.png"),target);repository.updateMedia(result.mediaIds[0],{status:"ready",localPath:target,byteSize:1772498,originalFilename:"entrega-cafetera.png"})}
      }else{repository.createOutboundMessage({conversationId,author,body,switchToHuman:author==="operator",createdAt:at})}
    }
    if(chat.alias)repository.setAlias(contactId,chat.alias);
    if(chat.mode)repository.setMode(conversationId,chat.mode,"demo_seed");
    if(!chat.unread)repository.markRead(conversationId,true);
  }
  repository.setMeta("operator_demo_v1",new Date().toISOString());database.close();
}
