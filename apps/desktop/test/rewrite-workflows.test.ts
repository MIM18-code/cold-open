import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenplayDoc, plainText, type Paragraph } from "@screenplay/engine";
import { HistoryStore } from "../src/main/history/store.ts";
import { encodeNative, decodeNative } from "../src/renderer/core/fileformat.ts";
import { anchorAt, resolveAnchor, createRecord, putRecord, records, RECORD_PREFIX, type ProjectRecord } from "../src/renderer/features/rewrite/records.ts";
import { scopedMatches } from "../src/renderer/features/editor/search-scope.ts";
import { findMatches, suggestions } from "../src/renderer/features/editor/rules.ts";
import { canonicalBinding, validateBindings, resolveCommands } from "../src/renderer/core/shortcuts.ts";

const scene: Paragraph[] = [
  { id:"head",sceneId:"scene-one",type:"sceneHeading",runs:[{text:"INT. ROOM - DAY"}] },
  { id:"action",type:"action",runs:[{text:"Mara waits by the door."}] },
  { id:"mara",type:"character",runs:[{text:"MARA"}] },
  { id:"line",type:"dialogue",runs:[{text:"Open the door."}] },
  { id:"eli",type:"character",runs:[{text:"ELI"}] },
  { id:"answer",type:"dialogue",runs:[{text:"Leave the door shut."}] },
];
const makeDoc = () => ScreenplayDoc.fromScript({titlePage:[],paragraphs:structuredClone(scene)});

test("history persists native snapshots, deduplicates automatic state and validates every read",async()=>{
  const root=await mkdtemp(join(tmpdir(),"screenplay-history-")),key=crypto.randomUUID(),store=new HistoryStore(root),doc=makeDoc();
  try{
    const first=await store.record({documentId:key,label:"Automatic",named:false,data:encodeNative(doc,"Draft")});
    const again=await store.record({documentId:key,label:"Another time",named:false,data:encodeNative(doc,"Draft")});
    assert.equal(first.id,again.id);
    doc.insertText("action",0,"Later: ");
    const named=await store.record({documentId:key,label:"Before changing the ending",named:true,data:encodeNative(doc,"Draft")});
    assert.notEqual(named.id,first.id);assert.equal((await store.list(key)).length,2);
    const old=decodeNative(await store.read(key,first.id));assert.equal(plainText(old.doc.paragraph("action").runs),"Mara waits by the door.");old.doc.ydoc.destroy();
    await writeFile(join(root,key,`${first.id}.screenplay`),"corrupted");
    await assert.rejects(()=>store.read(key,first.id),/integrity/);
    await assert.rejects(()=>store.read("../../secrets",named.id),/identifier/);
    await assert.rejects(()=>store.remove(key,"../../other"),/identifier/);
    assert.equal(plainText(doc.paragraph("action").runs),"Later: Mara waits by the door.");
  }finally{doc.ydoc.destroy();await rm(root,{recursive:true,force:true});}
});

test("history serializes concurrent records and never silently prunes named snapshots",async()=>{
  const root=await mkdtemp(join(tmpdir(),"screenplay-history-")),key=crypto.randomUUID(),store=new HistoryStore(root),doc=makeDoc();
  try{
    await Promise.all(Array.from({length:20},(_,i)=>store.record({documentId:key,label:`Named ${i}`,named:true,data:encodeNative(doc)})));
    assert.equal((await store.list(key)).length,20);
    await assert.rejects(()=>store.record({documentId:key,label:"One too many",named:true,data:encodeNative(doc)}),/Twenty/);
    assert.equal((await store.list(key)).filter((e)=>e.named).length,20);
  }finally{doc.ydoc.destroy();await rm(root,{recursive:true,force:true});}
});

test("note anchors track edits before their text, recover moved exact text, and never guess a deleted target",()=>{
  const doc=makeDoc();
  const anchor=anchorAt(doc,{paragraphId:"action",offset:5},{paragraphId:"action",offset:10});
  doc.insertText("action",0,"Now ");
  assert.deepEqual(resolveAnchor(doc,anchor),{paragraphId:"action",from:9,to:14});
  const script=doc.toScript();doc.load(script); // simulate a remove/reinsert of paragraphs retaining IDs
  assert.deepEqual(resolveAnchor(doc,anchor),{paragraphId:"action",from:9,to:14});
  doc.deleteParagraph("action");assert.equal(resolveAnchor(doc,anchor),null);doc.ydoc.destroy();
});

test("notes and inactive alternatives remain out of normal screenplay text and use independent record revisions",()=>{
  const doc=makeDoc(),a=createRecord("alternative","Try another line","Let me in."),b=createRecord("note","Producer note","Quietly.");
  putRecord(doc,a);putRecord(doc,b);
  const saved=records(doc).find((r)=>r.id===a.id)!;
  putRecord(doc,{...saved,text:"Open up."},saved.revision);
  assert.throws(()=>putRecord(doc,{...saved,text:"Stale overwrite"},saved.revision),/changed/);
  assert.equal(records(doc,"note").length,1);
  assert(!doc.toScript().paragraphs.some((p)=>plainText(p.runs).includes("Open up.")));
  assert.equal((doc.meta.get(RECORD_PREFIX+a.id) as ProjectRecord).text,"Open up.");doc.ydoc.destroy();
});

test("character and action search scopes cannot modify another speaker's matching words",()=>{
  const matches=findMatches(scene,"door",{matchCase:false,wholeWord:true});assert.equal(matches.length,3);
  assert.deepEqual(scopedMatches(scene,matches,"character",{character:"MARA"}).map((m)=>m.paragraphId),["line"]);
  assert.deepEqual(scopedMatches(scene,matches,"action",{}).map((m)=>m.paragraphId),["action"]);
  assert.equal(scopedMatches(scene,matches,"selection",{from:{paragraphId:"line",offset:0},to:{paragraphId:"line",offset:13}}).length,1);
  assert.equal(scopedMatches(scene,matches,"scene",{sceneId:"missing"}).length,0);
});

test("shortcut overrides preserve default commands and reject collisions or plain typing keys",()=>{
  const commands=[{id:"a",label:"Action",accelerator:"CmdOrCtrl+2",run(){}},{id:"b",label:"Dialogue",accelerator:"CmdOrCtrl+5",run(){}}];
  assert.strictEqual(resolveCommands(commands,{})[0],commands[0]);
  assert.equal(resolveCommands(commands,{a:"CmdOrCtrl+Shift+A"})[0]!.accelerator,"CmdOrCtrl+Shift+A");
  assert.equal(canonicalBinding("Command+Shift+A"),canonicalBinding("Shift+Cmd+A"));
  assert.throws(()=>validateBindings(commands,{a:"CmdOrCtrl+5"}),/collision/);
  assert.throws(()=>validateBindings(commands,{a:"Alt+A"}),/accent/);
  assert.throws(()=>validateBindings(commands,{a:"CmdOrCtrl+V"}),/reserved/);
});

test("project SmartType custom lists add suggestions and suppress misspellings",()=>{
  assert.deepEqual(suggestions("character","MAR",3,scene,{names:["MARIAN"],excluded:["MARA"]})?.items,["MARIAN"]);
  assert(suggestions("sceneHeading","INT. WARE",9,scene,{locations:["WAREHOUSE"]})?.items.includes("WAREHOUSE - "));
});
