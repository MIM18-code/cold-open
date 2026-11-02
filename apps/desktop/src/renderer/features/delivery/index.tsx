import { assertUniqueSceneNumbers, characterName, plainText, scenesOf, type ElementType, type Pagination } from "@screenplay/engine";
import { useMemo, useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { useScript, useSession, useSetting } from "../../core/hooks.ts";
import { CHANNELS } from "../../../shared/api.ts";
import { desktop } from "../../core/platform.ts";
import { currentPagination } from "../print/live.ts";
import { printOptions, readPrintSettings } from "../print/options.ts";
import { resolveSceneNumbersForDelivery } from "../revisions/settle.ts";
import { compactSides } from "./sides.ts";
import { drawPages, pageSvg } from "../print/pages.ts";
import { escapeReportHtml } from "@screenplay/engine";
import "./delivery.css";

interface DeliveryPrefs { watermark:string;recipient:string;header:string;footer:string;highlight:boolean; }
const defaults:DeliveryPrefs={watermark:"",recipient:"",header:"{title}",footer:"Sheet {page} of {pages} · Source {source}",highlight:false};
export function deliveryLabel(template:string,values:Record<string,string>):string{return template.replace(/\{(title|date|page|pages|recipient|source)\}/g,(_,key:string)=>values[key]??"");}
function DeliveryModal(){
  const session=useSession(),script=useScript(0),[mode,setMode]=useState<"draft"|"sides"|"elements">("draft"),[character,setCharacter]=useState(""),[chosen,setChosen]=useState<Set<string>>(new Set());
  const [compact,setCompact]=useState(false);
  const [types,setTypes]=useState<Set<ElementType>>(new Set(["sceneHeading","action","dialogue","character","parenthetical"]));
  const [prefs,setPrefs]=useSetting<DeliveryPrefs>("delivery.preset",defaults),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const scenes=scenesOf(script.paragraphs),names=[...new Set(script.paragraphs.filter((p)=>p.type==="character").map((p)=>characterName(plainText(p.runs))))].sort();
  const selectCharacter=(name:string)=>{setCharacter(name);setChosen(new Set(scenes.filter((s)=>script.paragraphs.slice(s.start,s.end).some((p)=>p.type==="character"&&characterName(plainText(p.runs))===name)).map((s)=>s.sceneId)));};
  const prepared=useMemo(()=>{
    const original=currentPagination(app,script),ids=new Set(scenes.filter((s)=>chosen.has(s.sceneId)).flatMap((s)=>s.paragraphIds));
    let currentSpeaker="";const highlight=new Set<string>();for(const p of script.paragraphs){if(p.type==="character")currentSpeaker=characterName(plainText(p.runs));else if(!["dialogue","parenthetical","lyrics","note"].includes(p.type))currentSpeaker="";if(character&&currentSpeaker===character)highlight.add(p.id);}
    const compactResult = mode === "sides" && compact ? compactSides(script, original, chosen, printOptions(script, readPrintSettings(app.settings))) : null;
    const base = compactResult?.pagination ?? original;
    const pages=base.pages.map((p)=>({...p,lines:p.lines.filter((line)=>mode==="draft"||(mode==="sides"?ids.has(line.paragraphId):types.has(line.type))).map((line)=>prefs.highlight&&highlight.has(line.paragraphId)?{...line,runs:line.runs.map((r)=>({...r,bold:true as const}))}:line)})).filter((p)=>p.lines.length);
    const pagination:Pagination={...base,pages};
    const drawings=drawPages(compactResult?.script ?? script,pagination,{sceneNumbers:"both",header:"",titlePage:null});
    return{drawings,page:original.layout.page,sourcePages:compactResult?.sourcePages};
  },[script,mode,chosen,types,character,prefs.highlight,compact]);
  const html=()=>{
    const e=escapeReportHtml,page=prepared.page,date=new Date().toLocaleDateString();
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${e(session.name)}</title><style>@page{size:${page.width}in ${page.height}in;margin:0}body{margin:0}section{position:relative;width:${page.width}in;height:${page.height}in;break-after:page;overflow:hidden}section:last-child{break-after:auto}.delivery-head,.delivery-foot{position:absolute;left:.65in;right:.65in;font:10px Arial;color:#444;white-space:nowrap}.delivery-head{top:.25in}.delivery-foot{bottom:.25in;text-align:center}.delivery-watermark{position:absolute;left:6%;right:6%;top:46%;transform:rotate(-32deg);text-align:center;font:42px Arial;color:rgba(80,80,80,.18);overflow-wrap:anywhere;pointer-events:none}</style></head><body>${prepared.drawings.map((d,i)=>{const source=(prepared.sourcePages?.get(d.key) ?? [d.key]).join(", ");const values={title:session.name,date,page:String(i+1),pages:String(prepared.drawings.length),source,recipient:prefs.recipient};return `<section aria-label="${compact && mode==="sides"?"Booklet page":"Source page"} ${e(d.key)}">${pageSvg(d,page)}<div class="delivery-head">${e(deliveryLabel(prefs.header,values))}</div><div class="delivery-foot">${e(deliveryLabel(prefs.footer,values))}${mode!=="draft" && !prefs.footer.includes("{source}")?` · Source page${source.includes(",")?"s":""} ${e(source)}`:""}</div><div class="delivery-watermark">${e(deliveryLabel(prefs.watermark,values))}</div></section>`;}).join("")}</body></html>`;
  };
  const exportPdf=async()=>{setBusy(true);setError("");try{
    resolveSceneNumbersForDelivery(session);
    assertUniqueSceneNumbers(session.script());
    if(!prepared.drawings.length)throw new Error("Choose at least one scene or printable element.");
    app.flushPending();if(session!==app.session||session.script()!==script)throw new Error("The draft changed. Let the preview refresh first.");
    const request={title:session.name,width:prepared.page.width,height:prepared.page.height,html:html()};
    const path=await desktop.invoke<string|null>(CHANNELS.saveDialog,{title:"Export delivery PDF",defaultPath:`${session.name}${mode==="draft"?"":" "+mode}.pdf`,filters:[{name:"PDF",extensions:["pdf"]}]});if(!path)return;
    const bytes=await desktop.invoke<Uint8Array>("print:pdf",request);await desktop.invoke(CHANNELS.writeFile,path,bytes);app.toast(`Exported ${prepared.drawings.length} ${compact && mode==="sides"?"compact booklet":"source-positioned"} pages from the previewed draft.`,"success");
  }catch(e){setError(String(e));}finally{setBusy(false);}};
  return <div className="delivery-workspace"><div className="delivery-controls">
    <label className="field"><span>Delivery</span><select aria-label="Delivery type" value={mode} onChange={(e)=>setMode(e.target.value as typeof mode)}><option value="draft">Full screenplay (without title page)</option><option value="sides">Actor / scene sides</option><option value="elements">Selected elements in screenplay layout</option></select></label>
    <p>{mode==="sides"&&compact?"Selected scenes are repaginated into a compact booklet. Original scene numbers and source-page references remain; master page locks and page breaks are unchanged.":"Source page positions and scene numbers are preserved."} Excluded material is omitted, not covered up. Use the normal PDF export for a full draft with its title page and production revision controls.</p>
    {mode==="sides"&&<><label><input type="checkbox" checked={compact} onChange={(e)=>setCompact(e.target.checked)}/>Compact actor booklet (repaginate selected scenes)</label><label className="field"><span>Select scenes by speaking character</span><select aria-label="Sides character" value={character} onChange={(e)=>selectCharacter(e.target.value)}><option value="">Choose / select scenes manually</option>{names.map((name)=><option key={name}>{name}</option>)}</select></label><div className="delivery-scene-list">{scenes.map((s)=><label key={s.sceneId}><input type="checkbox" checked={chosen.has(s.sceneId)} onChange={()=>setChosen((old)=>{const n=new Set(old);n.has(s.sceneId)?n.delete(s.sceneId):n.add(s.sceneId);return n;})}/>{plainText(script.paragraphs[s.start]!.runs)}</label>)}</div><small>Character selection identifies speaking roles only. Add silent-appearance scenes manually.</small></>}
    {mode==="elements"&&<fieldset><legend>Include elements</legend>{(["sceneHeading","action","character","dialogue","parenthetical","transition","shot","lyrics"] as ElementType[]).map((type)=><label key={type}><input type="checkbox" checked={types.has(type)} onChange={()=>setTypes((old)=>{const n=new Set(old);n.has(type)?n.delete(type):n.add(type);return n;})}/>{type}</label>)}</fieldset>}
    <label className="field"><span>Recipient</span><input aria-label="Delivery recipient" maxLength={100} value={prefs.recipient} onChange={(e)=>void setPrefs({...prefs,recipient:e.target.value})}/></label>
    {(["watermark","header","footer"] as const).map((key)=><label className="field" key={key}><span>{key[0]!.toUpperCase()+key.slice(1)}</span><input aria-label={`Delivery ${key}`} maxLength={160} value={prefs[key]} onChange={(e)=>void setPrefs({...prefs,[key]:e.target.value})}/></label>)}
    <small>Fields: {"{title}, {date}, {page}, {pages}, {recipient}, {source}"}. Page counts refer to this delivery; source references identify the original draft.</small>
    <label><input type="checkbox" checked={prefs.highlight} onChange={(e)=>void setPrefs({...prefs,highlight:e.target.checked})}/>Emphasize the selected character’s lines</label>
    <div className="preference-actions"><button className="button" onClick={()=>void setPrefs(defaults)}>Clean preset</button><button className="button" onClick={()=>void setPrefs({...prefs,watermark:"For {recipient}",footer:"{date} · Sheet {page} of {pages} · Source {source}"})}>Recipient preset</button></div>
    {error&&<p role="alert">{error}</p>}<button className="button primary" disabled={busy||!prepared.drawings.length} onClick={()=>void exportPdf()}>{busy?"Rendering PDF…":"Export previewed PDF…"}</button>
    <p>PDF rendering uses this Mac’s fonts. Review non-Latin shaping and font substitutions before delivery. Tagged output is not a PDF/UA certification.</p>
  </div><iframe className="delivery-preview-frame" title="Delivery page preview" sandbox="" srcDoc={html()} /></div>;
}
const feature:Feature={id:"delivery",commands:[{id:"delivery.open",label:"Delivery PDF, Watermarks and Actor Sides…",menu:"File",group:"export",run:(a)=>{a.flushPending();resolveSceneNumbersForDelivery(a.session);a.openModal("delivery.main");}}],modals:[{id:"delivery.main",title:"Preview delivery PDF / sides",width:"wide",component:DeliveryModal}]};
export default feature;
