import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Checks, Clock, EnvelopeOpen, MagnifyingGlass, NotePencil, PaperPlaneRight, Pause, Play, Robot, Trash, UserCircle, WarningCircle, X } from "@phosphor-icons/react";
import { api } from "./lib/api";
import type { Conversation, Media, Message } from "./lib/types";

type Filter="all"|"unread"|"human";

export function App(){
  const previewPhone=new URLSearchParams(window.location.search).get("qa")==="phone";
  const [conversations,setConversations]=useState<Conversation[]>([]),[selected,setSelected]=useState<string|null>(null),[messages,setMessages]=useState<Message[]>([]);
  const [search,setSearch]=useState(""),[filter,setFilter]=useState<Filter>("all"),[loading,setLoading]=useState(true),[error,setError]=useState(""),[mobileChat,setMobileChat]=useState(false);
  const active=conversations.find(c=>c.id===selected)||null;
  const refresh=useCallback(async()=>{try{const {conversations:list}=await api.conversations(search,filter);setConversations(list);setSelected(id=>id&&list.some(c=>c.id===id)?id:list[0]?.id||null);setError("")}catch(e){setError(messageOf(e))}finally{setLoading(false)}},[search,filter]);
  const loadMessages=useCallback(async(id:string)=>{try{const data=await api.messages(id);setMessages(data.messages);setError("")}catch(e){setError(messageOf(e))}},[]);
  useEffect(()=>{const t=setTimeout(refresh,120);return()=>clearTimeout(t)},[refresh]);
  useEffect(()=>{if(selected)loadMessages(selected);else setMessages([])},[selected,loadMessages]);
  useEffect(()=>{const stream=new EventSource("/api/events");const update=()=>{refresh();if(selected)loadMessages(selected)};["conversation.created","message.created","message.status","media.ready","contact.alias","conversation.unread","conversation.mode","conversation.deleted"].forEach(e=>stream.addEventListener(e,update));return()=>stream.close()},[refresh,selected,loadMessages]);
  useEffect(()=>{const timer=setInterval(refresh,60000);return()=>clearInterval(timer)},[refresh]);
  async function mutate(work:()=>Promise<unknown>){try{await work();await refresh();if(selected)await loadMessages(selected);setError("")}catch(e){setError(messageOf(e))}}
  return <main className={`shell ${previewPhone?"phone-preview":""}`}>
    <aside className={`sidebar ${mobileChat?"mobile-hidden":""}`}>
      <BrandHeader />
      <div className="inbox-tools">
        <label className="search"><MagnifyingGlass size={18}/><input aria-label="Buscar conversaciones" placeholder="Buscar por nombre o número" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button onClick={()=>setSearch("")} aria-label="Limpiar búsqueda"><X size={15}/></button>}</label>
        <div className="filters" aria-label="Filtros">{([['all','Todos'],['unread','No leídos'],['human','Humano']] as const).map(([key,label])=><button key={key} className={filter===key?"active":""} onClick={()=>setFilter(key)}>{label}</button>)}</div>
      </div>
      <div className="conversation-list">
        {loading&&<Empty text="Cargando conversaciones…"/>}
        {!loading&&!conversations.length&&<Empty text="No hay conversaciones para mostrar."/>}
        {conversations.map(c=><ConversationRow key={c.id} conversation={c} active={selected===c.id} onClick={()=>{setSelected(c.id);setMobileChat(true);if(c.unreadCount)mutate(()=>api.read(c.id,true))}}/>)}
      </div>
      <div className="local-note"><span className="pulse"/> Datos guardados localmente en este PC</div>
    </aside>
    <section className={`chat ${mobileChat?"mobile-visible":""}`}>
      {active?<ChatView conversation={active} messages={messages} onBack={()=>setMobileChat(false)} mutate={mutate} onDeleted={()=>{setSelected(null);setMobileChat(false)}}/>:<EmptyState/>}
    </section>
    {error&&<div className="toast" role="alert"><WarningCircle size={19}/>{error}<button onClick={()=>setError("")}><X size={16}/></button></div>}
  </main>
}

function BrandHeader(){return <header className="brand"><img src="/assets/automated-co-mark.png"/><div><b>Automated & CO</b><span>Bandeja de WhatsApp</span></div></header>}

function ConversationRow({conversation:c,active,onClick}:{conversation:Conversation;active:boolean;onClick:()=>void}){
  return <button className={`conversation ${active?"selected":""}`} onClick={onClick}>
    <Avatar name={c.displayName}/><div className="conversation-copy"><div className="row-title"><b>{c.displayName}</b><time>{formatListTime(c.lastMessageAt)}</time></div><span className="phone">{c.maskedPhone}</span><div className="preview"><span>{c.preview||"Archivo recibido"}</span><span className={`mode-dot ${c.mode}`}>{c.mode==="human"?"Humano":"Bot"}</span>{c.unreadCount>0&&<i>{c.unreadCount}</i>}</div></div>
  </button>
}

function ChatView({conversation:c,messages,mutate,onBack,onDeleted}:{conversation:Conversation;messages:Message[];mutate:(work:()=>Promise<unknown>)=>Promise<void>;onBack:()=>void;onDeleted:()=>void}){
  const [draft,setDraft]=useState(""),[sending,setSending]=useState(false),[editing,setEditing]=useState(false),[alias,setAlias]=useState(c.localAlias||""),[clock,setClock]=useState(Date.now());const scroller=useRef<HTMLDivElement>(null);
  useEffect(()=>{setAlias(c.localAlias||"")},[c.localAlias]);useEffect(()=>{if(scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight},[messages]);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),60000);return()=>clearInterval(timer)},[]);
  const remaining=useMemo(()=>windowRemaining(c.serviceWindowClosesAt),[c.serviceWindowClosesAt,clock]);
  async function send(){if(!draft.trim()||sending||!c.serviceWindowOpen)return;setSending(true);const body=draft.trim();setDraft("");await mutate(()=>api.reply(c.id,body));setSending(false)}
  async function saveAlias(){await mutate(()=>api.alias(c.contactId,alias.trim()||null));setEditing(false)}
  async function remove(){if(confirm(`¿Eliminar permanentemente la conversación con ${c.displayName} y sus archivos locales?`)){await api.remove(c.id);onDeleted()}}
  return <>
    <header className="chat-header"><button className="back" onClick={onBack}><ArrowLeft size={21}/></button><Avatar name={c.displayName}/><div className="identity"><div><b>{c.displayName}</b><button className="icon" aria-label="Editar alias" onClick={()=>setEditing(true)}><NotePencil size={16}/></button></div><span>{c.publicProfileName&&c.localAlias?`Nombre público: ${c.publicProfileName} · `:""}{c.maskedPhone}</span></div>
      <div className="header-actions"><button className="icon" aria-label={c.unreadCount?"Marcar como leído":"Marcar como no leído"} title={c.unreadCount?"Marcar como leído":"Marcar como no leído"} onClick={()=>mutate(()=>api.read(c.id,Boolean(c.unreadCount)))}><EnvelopeOpen size={18}/></button><button className={c.mode==="human"?"primary":"secondary"} onClick={()=>mutate(()=>api.mode(c.id,c.mode==="human"?"bot":"human"))}>{c.mode==="human"?<><Play size={16}/>Reanudar bot</>:<><Pause size={16}/>Atender yo</>}</button><button className="icon danger" aria-label="Eliminar conversación" onClick={remove}><Trash size={18}/></button></div>
    </header>
    {editing&&<div className="alias-editor"><label>Alias local<input autoFocus maxLength={80} value={alias} onChange={e=>setAlias(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveAlias()}/></label><button onClick={saveAlias}>Guardar</button><button className="icon" onClick={()=>setEditing(false)}><X/></button><small>El alias solo se guarda en este PC. El nombre público no se elimina.</small></div>}
    <div className="mode-banner">{c.mode==="human"?<><UserCircle size={17}/>Modo humano activo — el bot no responderá.</>:<><Robot size={17}/>Bot activo — responderá al próximo mensaje entrante.</>}</div>
    <div className="messages" ref={scroller}>{messages.map((m,index)=><MessageBubble key={m.id} message={m} showDate={index===0||day(messages[index-1].createdAt)!==day(m.createdAt)}/>)}</div>
    <footer className="composer">
      <div className={`window-status ${c.serviceWindowOpen?"open":"closed"}`}><Clock size={15}/>{c.serviceWindowOpen?`Ventana abierta · ${remaining}`:"Ventana de 24 h cerrada"}</div>
      <div className="compose-row"><textarea aria-label="Escribir respuesta" maxLength={1600} placeholder={c.serviceWindowOpen?"Escribe una respuesta…":"Espera un nuevo mensaje del cliente para responder"} disabled={!c.serviceWindowOpen} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}}/><button aria-label="Enviar respuesta" disabled={!draft.trim()||sending||!c.serviceWindowOpen} onClick={send}><PaperPlaneRight size={21} weight="fill"/></button></div>
      <div className="counter">{draft.length}/1.600</div>
    </footer>
  </>
}

function MessageBubble({message:m,showDate}:{message:Message;showDate:boolean}){return <>{showDate&&<div className="date-chip">{formatDay(m.createdAt)}</div>}{m.author==="system"?<div className="system-message">{m.body}</div>:<div className={`bubble-wrap ${m.author}`}><div className="bubble">{m.body&&<p>{m.body}</p>}{m.media.map(media=><MediaPreview key={media.id} media={media}/>)}<span className="meta">{formatTime(m.createdAt)} {m.author!=="customer"&&<Status status={m.providerStatus}/>}</span>{m.providerStatus==="failed"&&<small className="failed">No se pudo enviar</small>}</div></div>}</>}
function MediaPreview({media:m}:{media:Media}){if(m.status!=="ready"||!m.url)return <div className="media-pending">{m.status==="pending"?"Procesando archivo…":"Archivo no disponible"}</div>;if(m.contentType.startsWith("image/"))return <a href={m.url} target="_blank"><img className="media-image" src={m.url} alt={m.originalFilename||"Imagen recibida"}/></a>;if(m.contentType.startsWith("audio/"))return <audio controls src={m.url}/>;return <a className="file-card" href={m.url} target="_blank">📄 {m.originalFilename||"Abrir PDF"}</a>}
function Status({status}:{status:string|null}){if(status==="read")return <Checks size={14} weight="bold" className="read"/>;if(status==="delivered")return <Checks size={14} weight="bold"/>;if(status==="failed"||status==="undelivered")return <WarningCircle size={14}/>;return <Check size={14} weight="bold"/>}
function Avatar({name}:{name:string}){const initials=name.split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase();return <span className="avatar">{initials||"?"}</span>}
function Empty({text}:{text:string}){return <div className="empty-list">{text}</div>}
function EmptyState(){return <div className="empty-state"><img src="/assets/automated-co-mark.png"/><h1>Tu bandeja local</h1><p>Selecciona una conversación para leer y responder mensajes de WhatsApp.</p><span><span className="pulse"/> Solo visible en este PC</span></div>}
function messageOf(e:unknown){return e instanceof Error?e.message:String(e)}
function day(value:string){return new Date(value).toDateString()}
function formatTime(value:string){return new Intl.DateTimeFormat("es-CO",{hour:"numeric",minute:"2-digit"}).format(new Date(value))}
function formatListTime(value:string|null){if(!value)return"";const d=new Date(value),today=new Date();return day(value)===today.toDateString()?formatTime(value):new Intl.DateTimeFormat("es-CO",{day:"numeric",month:"short"}).format(d)}
function formatDay(value:string){const d=new Date(value),today=new Date();if(d.toDateString()===today.toDateString())return"Hoy";return new Intl.DateTimeFormat("es-CO",{weekday:"long",day:"numeric",month:"long"}).format(d)}
function windowRemaining(value:string|null){if(!value)return"cerrada";const ms=Math.max(0,Date.parse(value)-Date.now()),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000);return`${h} h ${m} min restantes`}
