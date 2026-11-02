import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadCue } from "@screenplay/engine";
import { ReadPlayer, type AudioHandle } from "../src/renderer/features/table-read/player.ts";
import { pronounce, parsePronunciationLines } from "../src/renderer/features/table-read/pronunciation.ts";
import { exportRead, monoPcm24k, waveHeader } from "../src/main/tts/wave-export.ts";
const tick=()=>new Promise((resolve)=>setTimeout(resolve,8));
const cue=(id:string,text=id,speaker="MARA"):ReadCue=>({id,text,speaker,paragraphIds:[id],source:[{paragraphId:id,from:0,to:text.length}],sceneId:"room",sceneHeading:"INT. ROOM",kind:"dialogue"});
function player(){const heard:string[]=[],handles:{done:()=>void;handle:AudioHandle}[]=[];const p=new ReadPlayer({
  synthesize:async(c)=>new TextEncoder().encode(c.text),cancel:async()=>{},highlight:()=>{},audio(bytes){heard.push(new TextDecoder().decode(bytes));let done!:()=>void;const promise=new Promise<void>((resolve)=>{done=resolve;});const handle:AudioHandle={done:promise,pause(){},resume:async()=>{},stop:()=>done(),rate(){}};handles.push({done,handle});return handle;}
});p.setGap(0);return{p,heard,handles};}
test("editing does not stop a pinned reading and updates start only after the current speech",async()=>{
  const f=player();f.p.play([cue("a","Old first"),cue("b","Old second")]);await tick();f.p.markEdited();assert.equal(f.p.state,"playing");assert(f.p.stale);
  f.p.queueUpdatedPlan([cue("a","Changed first"),cue("b","New second")]);assert.deepEqual(f.heard,["Old first"]);
  f.handles[0]!.done();await tick();assert.deepEqual(f.heard,["Old first","New second"]);assert(!f.p.stale);f.p.stop();
});
test("a muted rehearsal role waits for a manual cue without synthesizing or skipping its line",async()=>{
  const f=player();f.p.setRehearsalSpeaker("MARA");f.p.play([cue("a","My line"),cue("b","Other line","ELI")]);await tick();assert(f.p.awaitingCue);assert.deepEqual(f.heard,[]);
  f.p.resume();await tick();assert.deepEqual(f.heard,["Other line"]);f.p.stop();
});
test("looping a passage restarts the same captured wording and Stop cancels the repeat",async()=>{
  const f=player();f.p.setRepeat(true);f.p.play([cue("a")]);await tick();f.handles[0]!.done();await tick();assert.deepEqual(f.heard,["a","a"]);f.p.stop();f.handles[1]!.done();await tick();assert.equal(f.p.state,"idle");assert.equal(f.heard.length,2);
});
test("pronunciations match complete names, never regex or cascaded replacements",()=>{
  const rules=parsePronunciationLines("Mara = Mah-rah\nSt. John = Sinjin\nMah = Another");
  assert.equal(pronounce("Mara calls St. John, not Marabelle.",rules),"Mah-rah calls Sinjin, not Marabelle.");
  assert.throws(()=>parsePronunciationLines("Mara = \n"),/nonempty/);
});
const wave=()=>Buffer.concat([waveHeader(480),Buffer.alloc(480)]);
test("WAV export normalizes samples, preserves an existing destination on cancel and returns chapter times",async()=>{
  assert.equal(monoPcm24k(wave()).length,480);
  const dir=await mkdtemp(join(tmpdir(),"screenplay-read-export-")),path=join(dir,"read.wav"),abort=new AbortController();
  const request={id:"render-test",path,engine:"system" as const,title:"A read",gapMs:100,cues:[{id:"a",text:"One",voice:"Samantha",scene:"First",speaker:"Mara"},{id:"b",text:"Two",voice:"Samantha",scene:"Second",speaker:"Eli"}]};
  try{
    const manifest=await exportRead(request,abort.signal,async()=>({audio:wave()}),()=>{});
    const output=await readFile(path);assert.equal(output.readUInt32LE(40),output.length-44);assert.equal(manifest.chapters.length,2);assert(Math.abs(manifest.seconds-0.12)<0.0001);
    await writeFile(path,"existing audio");const cancel=new AbortController();
    await assert.rejects(()=>exportRead(request,cancel.signal,async()=>({audio:wave()}),()=>cancel.abort()));
    assert.equal(await readFile(path,"utf8"),"existing audio");assert.deepEqual(await readdir(dir),["read.wav"]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
