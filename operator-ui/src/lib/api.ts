import type { Conversation, Message } from "./types";

async function request<T>(url:string, init?:RequestInit):Promise<T>{
  const response=await fetch(url,{...init,headers:{"Content-Type":"application/json",...init?.headers}});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||`Error ${response.status}`)}
  return response.status===204 ? (undefined as T) : response.json();
}
export const api={
  conversations:(search="",filter="all")=>request<{conversations:Conversation[]}>(`/api/conversations?search=${encodeURIComponent(search)}&filter=${filter}`),
  messages:(id:string)=>request<{conversation:Conversation;messages:Message[]}>(`/api/conversations/${id}/messages`),
  alias:(contactId:string,alias:string|null)=>request(`/api/contacts/${contactId}`,{method:"PATCH",body:JSON.stringify({alias})}),
  reply:(id:string,body:string)=>request(`/api/conversations/${id}/replies`,{method:"POST",body:JSON.stringify({body})}),
  mode:(id:string,mode:"bot"|"human")=>request(`/api/conversations/${id}/mode`,{method:"POST",body:JSON.stringify({mode})}),
  read:(id:string,read:boolean)=>request(`/api/conversations/${id}/read`,{method:"POST",body:JSON.stringify({read})}),
  remove:(id:string)=>request<void>(`/api/conversations/${id}`,{method:"DELETE"})
};
