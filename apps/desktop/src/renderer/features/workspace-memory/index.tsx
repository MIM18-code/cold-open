import { useEffect, useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { useSetting } from "../../core/hooks.ts";
import { CHANNELS } from "../../../shared/api.ts";
import { desktop, isDesktop } from "../../core/platform.ts";
import type { EditorBridge } from "../../core/editor-bridge.ts";

interface PositionMemory { paragraphId: string; offset: number; scrollTop: number; at: number; }
const pathKeys = new Map<string, Promise<string>>();
function positionKey(path: string): Promise<string> {
  let key = pathKeys.get(path);
  if (!key) { key = crypto.subtle.digest("SHA-256",new TextEncoder().encode(path)).then((bytes)=>"workspace.position."+[...new Uint8Array(bytes)].map((b)=>b.toString(16).padStart(2,"0")).join(""));pathKeys.set(path,key); }
  return key;
}
function RecentWorkspace(){
  const [recent,setRecent]=useState<string[]>([]),[pins,setPins]=useSetting<string[]>("workspace.pinnedScripts",[]),[error,setError]=useState("");
  useEffect(()=>{void desktop.invoke<string[]>(CHANNELS.recentFiles).then(setRecent,(e)=>setError(String(e)));},[]);
  const safePins=Array.isArray(pins)?pins.filter((p)=>typeof p==="string").slice(0,20):[];
  // Only offer entries still present in the main-process verified recent-file collection.
  const listed=[...recent].sort((a,b)=>Number(safePins.includes(b))-Number(safePins.includes(a)));
  return <div><p>Open a recent script without replacing the draft in this window. Pinned entries stay at the top.</p>
    {error&&<p role="alert">{error}</p>}
    <div className="file-choice-list">{listed.map((path)=><div className="workspace-recent-item" key={path} style={{display:"flex",gap:8}}>
      <button className="file-choice list-row" onClick={()=>void desktop.invoke(desktop.platform==="darwin"?CHANNELS.newTab:CHANNELS.newWindow,path).then(()=>app.closeModal(),(e)=>setError(String(e)))}><strong>{path.split("/").pop()}</strong><small>{path}</small></button>
      <button className="button" aria-label={`${safePins.includes(path)?"Unpin":"Pin"} ${path.split("/").pop()}`} aria-pressed={safePins.includes(path)} onClick={()=>void setPins(safePins.includes(path)?safePins.filter((p)=>p!==path):[...safePins,path].slice(-20))}>{safePins.includes(path)?"Unpin":"Pin"}</button>
    </div>)}</div>
    {!listed.length&&<p>No recent scripts yet. Open a script to add it here.</p>}
    <div className="modal-actions"><button className="button" onClick={()=>{app.closeModal();void app.runCommand("file.new");}}>New screenplay</button><button className="button" onClick={()=>{app.closeModal();void app.runCommand("file.open");}}>Open a script…</button></div>
  </div>;
}
function MemorySettings(){const [restore,setRestore]=useSetting("workspace.restorePosition",true),[windows,setWindows]=useSetting("workspace.restoreWindows",false);return <div><label><input type="checkbox" checked={restore} onChange={(e)=>void setRestore(e.target.checked)}/>Return to the last writing position when reopening a saved script</label><p>Positions are stored in this Mac’s settings, not in the screenplay or cloud. Missing paragraphs fall back to the start. </p><label><input type="checkbox" checked={windows} onChange={(e)=>setWindows(e.target.checked)}/>Reopen saved scripts and window positions when launching</label><p>Up to 20 saved scripts reopen as separate windows. Unsaved work uses the existing recovery prompt. Missing or linked files are skipped. Turn this off before opening private drafts on a shared Mac.</p><button className="button" onClick={()=>app.openModal("workspace.recentPinned")}>Recent and pinned scripts</button></div>;}
const feature:Feature={id:"workspace-memory",commands:[{id:"workspace.recentPinned",label:"Recent and Pinned Scripts…",menu:"File",group:"new",run:(a)=>a.openModal("workspace.recentPinned")}],modals:[{id:"workspace.recentPinned",title:"Recent and pinned scripts",width:760,component:RecentWorkspace}],settings:[{id:"workspaceMemory",title:"Workspace memory",order:19,component:MemorySettings}],activate(a){
  let boundSession = a.session;
  let editor:EditorBridge|null=null, offSelection=()=>{},offState=()=>{},timer:ReturnType<typeof setTimeout>|undefined,epoch=0,key:string|null=null;
  let scroller:HTMLElement|null=null,scrolled=()=>{},typing=false;
  const bind=()=>{
    if(a.editor===editor && a.session===boundSession)return;
    boundSession=a.session;
    offSelection();offState();scroller?.removeEventListener("scroll",scrolled);clearTimeout(timer);epoch++;key=null;editor=a.editor;
    if(!editor||!isDesktop)return;
    const active=editor,session=a.session,myEpoch=epoch;
    const save=()=>{clearTimeout(timer);timer=setTimeout(()=>{
      if(myEpoch!==epoch||!key||!session.path||!a.setting("workspace.restorePosition",true))return;
      const point=active.getSelection()?.head;if(!point)return;
      const value:PositionMemory={...point,scrollTop:scroller?.scrollTop??0,at:Date.now()};
      void a.setSetting(key,value).catch(()=>undefined);
    },500);};
    scroller=document.querySelector<HTMLElement>(".editor-scroll");scrolled=save;scroller?.addEventListener("scroll",scrolled,{passive:true});
    const configure=async()=>{
      if(!session.path)return;
      const token=epoch,path=session.path,version=session.version;
      const next=await positionKey(path);if(token!==epoch||a.session!==session||session.path!==path)return;
      const was=key;key=next;
      if(was===next||!a.setting("workspace.restorePosition",true)||session.version!==version)return;
      const stored=a.setting<PositionMemory|null>(next,null);
      if(!stored||typeof stored.paragraphId!=="string"||!Number.isFinite(stored.offset)||!Number.isFinite(stored.scrollTop)||!session.doc.has(stored.paragraphId))return;
      requestAnimationFrame(()=>{if(epoch!==token||typing||a.session!==session||session.version!==version)return;active.setSelection({paragraphId:stored.paragraphId,offset:Math.max(0,Math.min(stored.offset,session.doc.paragraph(stored.paragraphId).runs.reduce((n,r)=>n+r.text.length,0)))});if(scroller)scroller.scrollTop=Math.max(0,stored.scrollTop);});
    };
    typing=false;const markInput=()=>{typing=true;};document.addEventListener("beforeinput",markInput,{once:true,capture:true});
    offSelection=active.onSelectionChange(save);offState=session.onState(()=>{void configure().catch(()=>undefined);});
    const oldOff=offState;offState=()=>{oldOff();document.removeEventListener("beforeinput",markInput,true);};
    void configure().catch(()=>undefined);
  };
  bind();const off=a.subscribe(bind);return()=>{off();offSelection();offState();scroller?.removeEventListener("scroll",scrolled);clearTimeout(timer);};
}};
export default feature;
