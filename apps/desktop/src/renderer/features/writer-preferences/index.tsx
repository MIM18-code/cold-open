import { useEffect, useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { useApp, useDocVersion, useSession, useSetting } from "../../core/hooks.ts";
import { validateBindings, WRITERDUET_ELEMENTS, type BindingMap } from "../../core/shortcuts.ts";
import { formatAccelerator } from "../../shell/Shell.tsx";
import { CHANNELS, type OpenedFile } from "../../../shared/api.ts";
import { desktop, messageBox } from "../../core/platform.ts";
import "./preferences.css";

const EMPTY_BINDINGS: BindingMap = {};
function ShortcutsSettings(){
  const [bindings,setBindings]=useSetting<BindingMap>("keyboard.bindings",EMPTY_BINDINGS),[query,setQuery]=useState(""),[selected,setSelected]=useState("editor.element.action"),[value,setValue]=useState(""),[error,setError]=useState("");
  const commands=useApp((a)=>a.commands),raw=app.features.flatMap((f)=>f.commands??[]);
  useEffect(()=>{setValue(commands.find((c)=>c.id===selected)?.accelerator??"");},[selected,bindings]);
  const apply=async(next:BindingMap)=>{try{validateBindings(raw,next);await setBindings(next);app.refreshMenu();setError("");}catch(e){setError(String(e));}};
  return <div className="shortcut-settings"><p>Menus and the editor use the same bindings. Bare letter/Option-letter shortcuts are not accepted, preserving text and accent entry.</p>
    <div className="preference-actions"><button className="button" onClick={()=>void apply({})}>Default / Final Draft elements</button><button className="button" onClick={()=>void apply({...bindings,...WRITERDUET_ELEMENTS})}>WriterDuet-style elements</button></div>
    <input aria-label="Filter remappable shortcuts" type="search" placeholder="Find a command" value={query} onChange={(e)=>setQuery(e.target.value)}/>
    <select size={8} aria-label="Command to remap" value={selected} onChange={(e)=>setSelected(e.target.value)}>{commands.filter((c)=>!c.hidden&&`${c.label} ${c.menu??""}`.toLowerCase().includes(query.toLowerCase())).map((c)=><option key={c.id} value={c.id}>{c.label} {c.accelerator?`(${formatAccelerator(c.accelerator)})`:""}</option>)}</select>
    <label className="field"><span>Binding, for example CmdOrCtrl+Shift+E</span><input aria-label="Shortcut binding" value={value} maxLength={80} onChange={(e)=>setValue(e.target.value)}/></label>
    <div className="preference-actions"><button className="button primary" onClick={()=>void apply({...bindings,[selected]:value.trim()||null})}>Apply binding</button><button className="button" onClick={()=>void apply({...bindings,[selected]:null})}>Clear binding</button><button className="button" onClick={()=>{const next={...bindings};delete next[selected];void apply(next);}}>Restore this default</button></div>
    {error&&<p role="alert">{error}</p>}
    <div className="preference-actions"><button className="button" onClick={()=>void(async()=>{const path=await desktop.invoke<string|null>(CHANNELS.saveDialog,{title:"Export keyboard shortcuts",defaultPath:"screenplay-shortcuts.json",filters:[{name:"JSON",extensions:["json"]}]});if(path)await desktop.invoke(CHANNELS.writeFile,path,JSON.stringify({version:1,bindings},null,2));})().catch((e)=>setError(String(e)))}>Export map…</button>
      <button className="button" onClick={()=>void(async()=>{const [file]=await desktop.invoke<OpenedFile[]>(CHANNELS.openDialog,{title:"Import keyboard shortcuts",filters:[{name:"JSON",extensions:["json"]}]});if(!file)return;if(file.data.length>100000)throw new Error("This shortcut map is too large.");const data=JSON.parse(new TextDecoder().decode(file.data));if(data.version!==1||!data.bindings||typeof data.bindings!=="object"||Array.isArray(data.bindings))throw new Error("Invalid shortcut map.");await apply(data.bindings);})().catch((e)=>setError(String(e)))}>Import map…</button></div>
  </div>;
}
const fields=["names","locations","transitions","times","extensions","excluded"] as const;
type Lists=Record<(typeof fields)[number],string[]>;
export function normalizeSmartLists(value:unknown):Lists {
  const raw=value&&typeof value==="object"?value as Partial<Lists>:{};
  return Object.fromEntries(fields.map((key)=>[key,Array.isArray(raw[key])?[...new Set(raw[key]!.filter((s):s is string=>typeof s==="string").map((s)=>s.trim().toUpperCase()).filter(Boolean))].slice(0,250):[]])) as Lists;
}
function SmartTypeSettings(){
  useDocVersion();const session=useSession();const [base,setBase]=useState(()=>session.doc.meta.get("editor.smartType.v1"));
  const [text,setText]=useState(()=>Object.fromEntries(fields.map((f)=>[f,normalizeSmartLists(base)[f].join("\n")])) as Record<(typeof fields)[number],string>),[error,setError]=useState("");
  return <div className="smarttype-settings"><p>One entry per line. These supplement script-derived suggestions. Excluded entries suppress unwanted suggestions without changing screenplay text; use Rename Character to correct the script itself.</p>
    {fields.map((field)=><label className="field" key={field}><span>{({names:"Character names",locations:"Locations",transitions:"Transitions",times:"Times of day",extensions:"Cue extensions",excluded:"Excluded suggestions"})[field]}</span><textarea aria-label={`SmartType ${field}`} rows={3} maxLength={20000} value={text[field]} onChange={(e)=>setText({...text,[field]:e.target.value})}/></label>)}
    <button className="button primary" disabled={session.readOnly} onClick={()=>{try{if(app.session!==session||session.doc.meta.get("editor.smartType.v1")!==base)throw new Error("These lists changed elsewhere. Reopen Settings before applying.");const next=normalizeSmartLists(Object.fromEntries(fields.map((f)=>[f,text[f].split(/\r?\n/)])));session.undo.stopCapturing();session.edit(()=>session.doc.meta.set("editor.smartType.v1",next));session.undo.stopCapturing();setBase(next);setError("");app.toast("SmartType lists saved to the native draft.","success");}catch(e){setError(String(e));}}}>Save project lists</button>{error&&<p role="alert">{error}</p>}
    {session.format!=="screenplay"&&<p role="status">Use a .screenplay master to keep these lists across restarts.</p>}
  </div>;
}
function ReadabilitySettings(){
  const [size,setSize]=useSetting("appearance.uiSize","normal"),[density,setDensity]=useSetting("appearance.density","compact"),[contrast,setContrast]=useSetting("appearance.highContrast",false),[paper,setPaper]=useSetting("appearance.paper","theme"),[flow,setFlow]=useSetting("editor.continuous",false);
  return <div><label className="field"><span>Interface text</span><select aria-label="Interface text size" value={size} onChange={(e)=>void setSize(e.target.value)}><option value="normal">Normal</option><option value="large">Large</option></select></label>
    <label className="field"><span>Control spacing</span><select aria-label="Control density" value={density} onChange={(e)=>void setDensity(e.target.value)}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></label>
    <label className="field"><span>Paper appearance</span><select aria-label="Paper appearance" value={paper} onChange={(e)=>void setPaper(e.target.value)}><option value="theme">Match theme</option><option value="white">White paper</option><option value="sepia">Warm paper</option></select></label>
    <label className="field"><span><input type="checkbox" checked={contrast} onChange={(e)=>void setContrast(e.target.checked)}/>High-contrast interface</span></label>
    <label className="field"><span><input type="checkbox" checked={flow} onChange={(e)=>void setFlow(e.target.checked)}/>Continuous writing view (reflows on screen)</span></label>
    <p>These choices affect display only. They do not change page count, production locks or exported typography. Continuous view is for drafting, not a print preview.</p>
  </div>;
}
const feature:Feature={id:"writer-preferences",settings:[{id:"shortcuts",title:"Keyboard shortcuts",order:16,component:ShortcutsSettings},{id:"smarttype",title:"SmartType lists",order:17,component:SmartTypeSettings},{id:"readability",title:"Readability",order:1,component:ReadabilitySettings}],activate(a){const update=()=>{const root=document.documentElement;root.dataset.uiSize=a.setting("appearance.uiSize","normal");root.dataset.density=a.setting("appearance.density","compact");root.dataset.highContrast=String(a.setting("appearance.highContrast",false));root.dataset.paper=a.setting("appearance.paper","theme");root.dataset.continuous=String(a.setting("editor.continuous",false));};update();return a.subscribe(update);}};
export default feature;
