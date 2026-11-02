import { compileReadPlan, scenesOf, NARRATOR, type ReadCue, type ReadOptions, type Script } from "@screenplay/engine";
import { useEffect, useRef, useState } from "react";
import { app } from "../../core/app.ts";
import { useSession } from "../../core/hooks.ts";
import { desktop } from "../../core/platform.ts";
import { CHANNELS } from "../../../shared/api.ts";
import { TABLE_READ, type ReadEngine } from "../../../shared/channels/table-read.ts";
import { listeningNote } from "./notes.ts";
import { captureRead, restrictPassages } from "./workflow.ts";
import type { ReadPlayer } from "./player.ts";
import { parsePronunciationLines, pronunciationLines, pronounce, PRONUNCIATION_KEY } from "./pronunciation.ts";
import { anchorAt, createRecord, putRecord } from "../rewrite/records.ts";

export { PRONUNCIATION_KEY };
export function scopedRead(source: Script, options: ReadOptions, scope: string): ReadCue[] {
  let cues=compileReadPlan(source,options);
  const current=app.editor?.currentParagraphId(), selection=app.editor?.getSelection();
  if(scope.startsWith("scene:")) cues=cues.filter((c)=>c.sceneId===scope.slice(6));
  else if(scope==="scene"){
    const scene=scenesOf(source.paragraphs).find((s)=>!!current&&s.paragraphIds.includes(current));
    if(!scene)throw new Error("Put the caret in a scene, or choose Whole script.");
    cues=cues.filter((c)=>c.sceneId===scene.sceneId);
  }else if(scope==="caret"){
    const index=source.paragraphs.findIndex((p)=>p.id===current);
    if(index<0)throw new Error("Place the caret in the screenplay first.");
    const ids=new Set(source.paragraphs.slice(index).map((p)=>p.id));
    cues=restrictPassages(cues,ids,source);
  }else if(scope==="selection"){
    if(!selection||(selection.anchor.paragraphId===selection.head.paragraphId&&selection.anchor.offset===selection.head.offset))throw new Error("Select a passage in the screenplay first.");
    const start=source.paragraphs.findIndex((p)=>p.id===selection.anchor.paragraphId),end=source.paragraphs.findIndex((p)=>p.id===selection.head.paragraphId);
    if(start<0||end<0)throw new Error("The selected passage changed. Select it again.");
    const high=start>end?selection.anchor:selection.head;
    const ids=new Set(source.paragraphs.slice(Math.min(start,end),Math.max(start,end)+(start!==end&&high.offset===0?0:1)).map((p)=>p.id));
    cues=restrictPassages(cues,ids,source);
  }
  return cues;
}
export function ReaderExtras({player,engine,voices,options,scope,ready,onExporting}:{player:ReadPlayer;engine:ReadEngine;voices:Record<string,string>;options:ReadOptions;scope:string;ready:boolean;onExporting(active:boolean):void}){
  const session=useSession(),[rules,setRules]=useState(()=>pronunciationLines(session.doc.meta.get(PRONUNCIATION_KEY))),[error,setError]=useState("");
  const [exporting,setExporting]=useState(false),[progress,setProgress]=useState({completed:0,total:0}),[manifest,setManifest]=useState<unknown>(null);
  const activeExport=useRef<string|null>(null);
  useEffect(()=>{setRules(pronunciationLines(session.doc.meta.get(PRONUNCIATION_KEY)));setManifest(null);},[session]);
  useEffect(()=>{
    const off=desktop.on("table-read:export-progress",(raw)=>{const p=raw as {id:string;completed:number;total:number};if(p?.id===activeExport.current)setProgress(p);});
    return()=>{off();if(activeExport.current){activeExport.current=null;void desktop.invoke(TABLE_READ.cancel).catch(()=>undefined);}};
  },[]);
  const handle=(fn:()=>void|Promise<void>)=>{setError("");void Promise.resolve().then(fn).catch((e)=>setError(e instanceof Error?e.message:String(e)));};
  const update=()=>{
    let cues=compileReadPlan(session.script(),options);
    // Preserve the original scope, even if the writer moved the caret elsewhere during playback.
    if(scope==="scene" || scope.startsWith("scene:")){const ids=new Set(player.cues.map((c)=>c.sceneId));cues=cues.filter((c)=>ids.has(c.sceneId));}
    else if(scope==="selection"){const ids=new Set(player.cues.flatMap((c)=>c.paragraphIds));cues=cues.filter((c)=>c.paragraphIds.some((id)=>ids.has(id)));}
    else if(scope==="caret"){const first=player.cues[0]?.paragraphIds[0],at=session.script().paragraphs.findIndex((p)=>p.id===first);if(at<0)throw new Error("The reading's starting paragraph was removed. Restart from a new caret position.");const ids=new Set(session.script().paragraphs.slice(at).map((p)=>p.id));cues=cues.filter((c)=>c.paragraphIds.some((id)=>ids.has(id)));}
    player.queueUpdatedPlan(cues);
  };
  const exportAudio=async()=>{
    if(exporting)return;
    app.flushPending();if(app.session!==session)throw new Error("The open draft changed.");
    const source=session.script(),cues=scopedRead(source,options,scope),rules=session.doc.meta.get(PRONUNCIATION_KEY);
    if(!cues.length)throw new Error("There is no readable text in this range.");
    const snapshot = captureRead(cues, voices);
    const planned=snapshot.cues.map((c)=>{const voice=snapshot.voices[c.speaker];if(!voice)throw new Error(`Choose a voice for ${c.speaker}.`);return{id:c.id,text:pronounce(c.text,rules),voice,scene:c.sceneHeading,speaker:c.speaker};});
    const path=await desktop.invoke<string|null>(CHANNELS.saveDialog,{title:"Export table read",defaultPath:`${session.name} table read.wav`,filters:[{name:"WAV audio",extensions:["wav"]}]});
    if(!path||app.session!==session)return;
    player.stop();await desktop.invoke(TABLE_READ.cancel);
    const id=crypto.randomUUID();activeExport.current=id;setExporting(true);onExporting(true);setProgress({completed:0,total:planned.length});setManifest(null);
    try{
      const result=await desktop.invoke<unknown>("table-read:export",{id,path,engine,title:session.name,cues:planned,gapMs:player.gapMs});
      if(activeExport.current===id){setManifest({ sourceRevision: snapshot.sourceRevision, voices: snapshot.voices, result });app.toast("Exported the captured draft at natural speed. The chapter manifest is ready to save.","success");}
    }finally{if(activeExport.current===id)activeExport.current=null;setExporting(false);onExporting(false);}
  };
  return <section className="reader-extras" aria-label="Reading and rehearsal tools">
    {player.stale&&<div role="status"><p>The draft changed. Playback is still reading the captured version.</p><button className="button" disabled={player.updateQueued||exporting} onClick={()=>handle(update)}>{player.updateQueued?"Update queued after this speech":"Use updated text after this speech"}</button></div>}
    <label><input type="checkbox" checked={player.repeat} onChange={(e)=>player.setRepeat(e.target.checked)}/>Loop this reading range</label>
    <label className="field"><span>Rehearse a role</span><select aria-label="Silent rehearsal role" disabled={player.active||exporting} value={player.rehearsalSpeaker} onChange={(e)=>handle(()=>player.setRehearsalSpeaker(e.target.value))}><option value="">Read every role</option>{Object.keys(voices).filter((name)=>name!==NARRATOR).map((name)=><option key={name}>{name}</option>)}</select></label>
    {player.awaitingCue&&<button className="button primary" onClick={()=>player.resume()}>Your cue: continue after your line</button>}
    <button className="button" disabled={!player.active || session.readOnly} onClick={()=>handle(()=>{
      const cue = player.cues[player.index];
      if (!cue) return;
      const record = listeningNote(session, cue, { id: player.sessionId, revision: player.sourceRevision });
      app.openModal("rewrite.edit", { sessionId: session.id, isNew: true, record });
    })}>Note at this line</button>
    <div className="reader-footer"><button className="button" disabled={!player.cues[player.index]?.paragraphIds.length||session.readOnly} onClick={()=>handle(()=>{
      const cue=player.cues[player.index]!,id=cue.paragraphIds.find((id)=>session.doc.has(id));if(!id)throw new Error("That passage was removed.");
      session.undo.stopCapturing();session.edit(()=>putRecord(session.doc,createRecord("bookmark",`Listening: ${cue.sceneHeading}`,cue.text.slice(0,300),{anchor:anchorAt(session.doc,{paragraphId:id,offset:0})})));session.undo.stopCapturing();app.toast("Reading position saved in Bookmarks.","success");
    })}>Bookmark passage</button><button className="button" disabled={!ready||exporting} onClick={()=>handle(exportAudio)}>Export this range as WAV…</button></div>
    {exporting&&<div role="status"><progress value={progress.completed} max={Math.max(1,progress.total)}/><p>{progress.completed} / {progress.total} passages</p><button className="button" onClick={()=>handle(async()=>{await desktop.invoke(TABLE_READ.cancel);})}>Cancel audio export</button></div>}
    {manifest!==null&&<button className="button" onClick={()=>handle(async()=>{const path=await desktop.invoke<string|null>(CHANNELS.saveDialog,{title:"Save reading chapter manifest",defaultPath:`${session.name} reading chapters.json`,filters:[{name:"JSON",extensions:["json"]}]});if(path)await desktop.invoke(CHANNELS.writeFile,path,JSON.stringify(manifest,null,2));})}>Save chapter and voice manifest…</button>}
    <small>Audio exports use natural speed, the selected gap, and the captured draft. Playback speed, looping and silent-role rehearsal are not applied to exported audio.</small>
    <details><summary>Project pronunciations</summary><p>One rule per line: Mara = Mah-rah. These change spoken audio only.</p><textarea aria-label="Project pronunciations" rows={5} value={rules} maxLength={25000} onChange={(e)=>setRules(e.target.value)}/><button className="button" disabled={session.readOnly||player.active||exporting} onClick={()=>handle(()=>{const parsed=parsePronunciationLines(rules);session.undo.stopCapturing();session.edit(()=>session.doc.meta.set(PRONUNCIATION_KEY,parsed));session.undo.stopCapturing();app.toast("Pronunciations saved in this native draft.","success");})}>Save pronunciations</button></details>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
