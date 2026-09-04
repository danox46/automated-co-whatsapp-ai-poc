export type Conversation = {
  id:string; contactId:string; waId:string|null; publicProfileName:string|null; localAlias:string|null; displayName:string;
  maskedPhone:string; mode:"bot"|"human"; unreadCount:number; lastInboundAt:string|null; lastMessageAt:string|null;
  preview:string; serviceWindowClosesAt:string|null; serviceWindowOpen:boolean;
};
export type Media = { id:string; contentType:string; byteSize:number|null; originalFilename:string|null; status:string; errorMessage:string|null; url:string|null };
export type Message = { id:string; author:"customer"|"bot"|"operator"|"system"; body:string; providerStatus:string|null; errorMessage:string|null; createdAt:string; media:Media[] };
