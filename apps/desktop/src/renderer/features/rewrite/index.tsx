import { plainText, type Paragraph } from "@screenplay/engine";
import { useEffect, useState } from "react";
import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { useDocVersion, useSession, useSessionState } from "../../core/hooks.ts";
import { messageBox } from "../../core/platform.ts";
import { selectedParagraphs } from "../editor/clipboard.ts";
import { inOtherTextField } from "../../core/keyboard.ts";
import { anchorAt, createRecord, putRecord, records, resolveAnchor, RECORD_PREFIX, type ProjectRecord, type RecordKind } from "./records.ts";
import { revealScene } from "../navigator/structure-data.ts";
import { openQuickNote } from "../quick-notes/box.ts";
import "./rewrite.css";

function capture(kind: RecordKind): ProjectRecord {
  app.flushPending();
  const doc = app.session.doc, selection = app.editor?.getSelection(), current = app.editor?.currentParagraphId();
  if (kind === "beat") return createRecord(kind, "", "");
  if (!current || !doc.has(current)) throw new Error("Place the caret in the screenplay first.");
  const p = doc.paragraph(current), text = plainText(p.runs);
  const points = selection ? [selection.anchor, selection.head].sort((a,b) => doc.indexOf(a.paragraphId) - doc.indexOf(b.paragraphId) || a.offset-b.offset) : [];
  const from = points[0] ?? { paragraphId: p.id, offset: 0 }, to = points[1] ?? { paragraphId:p.id,offset:text.length };
  const hasSelection = from.paragraphId !== to.paragraphId || from.offset !== to.offset;
  const anchor = kind === "alternative" ? anchorAt(doc,{ paragraphId:p.id,offset:0 },{ paragraphId:p.id,offset:text.length })
    : anchorAt(doc, from, to);
  const paragraphs = kind === "cut" ? (hasSelection ? selectedParagraphs(doc.paragraphs(),from,to) : [p]) : undefined;
  if (kind === "alternative" && !["action","dialogue","parenthetical","lyrics"].includes(p.type)) throw new Error("Alternatives apply to action, dialogue, parentheticals or lyrics. Choose one of those paragraphs.");
  return createRecord(kind, kind === "bookmark" ? text.slice(0,100) : "", kind === "alternative" ? text : "", { anchor, ...(paragraphs ? {paragraphs}:{}), author: app.setting("collab.name", "Writer") });
}
function openNew(kind: RecordKind) { app.openModal("rewrite.edit", { sessionId: app.session.id, record: capture(kind), isNew: true }); }
function reveal(record: ProjectRecord) {
  const target = resolveAnchor(app.session.doc,record.anchor);
  if (!target) { app.toast("This item's original text is missing or ambiguous. Reattach it explicitly to a current paragraph.","info"); return; }
  app.closeModal(); app.setView("script"); revealScene(target.paragraphId);
  requestAnimationFrame(() => app.editor?.revealParagraph(target.paragraphId,{select:true,offset:target.from}));
}
interface EditProps { sessionId: string; record: ProjectRecord; isNew?: boolean; }
function EditRecord({ props, close }: ModalProps<EditProps>) {
  const [title,setTitle] = useState(props.record.title), [text,setText] = useState(props.record.text), [error,setError] = useState("");
  const save = () => {
    try {
      if (app.session.id !== props.sessionId) throw new Error("The open document changed. Nothing was applied.");
      app.session.undo.stopCapturing();
      app.session.edit(() => putRecord(app.session.doc,{...props.record,title,text},props.isNew ? undefined : props.record.revision));
      app.session.undo.stopCapturing(); close();
      if (props.record.kind !== "beat") { app.setFocusMode(false); app.togglePanel("rewrite",true); }
    } catch(e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <form onSubmit={(e)=>{e.preventDefault();save();}}>
    <label className="field"><span>Name</span><input autoFocus aria-label="Project item name" value={title} maxLength={160} onChange={(e)=>setTitle(e.target.value)}/></label>
    <label className="field"><span>{props.record.kind === "alternative" ? "Alternate wording (the script is unchanged until you swap it in)" : "Text"}</span><textarea aria-label="Project item text" rows={8} maxLength={20000} value={text} onChange={(e)=>setText(e.target.value)}/></label>
    {props.record.kind === "cut" && <p>This keeps a copy of the selected text and formatting. It does not delete anything from the draft.</p>}
    {props.record.paragraphs && <pre className="rewrite-excerpt">{props.record.paragraphs.map((p)=>plainText(p.runs)).join("\n\n")}</pre>}
    {error && <p role="alert">{error}</p>}
    <div className="modal-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={app.session.readOnly}>Keep {props.record.kind}</button></div>
  </form>;
}
function ProjectItem({ record }: { record:ProjectRecord }) {
  const session = useSession(), [error,setError] = useState("");
  const target = resolveAnchor(session.doc,record.anchor);
  const run = (fn:()=>void) => { try { if (app.session!==session) throw new Error("The open document changed."); fn(); } catch(e){setError(String(e));} };
  const update = (next:ProjectRecord) => { session.undo.stopCapturing();session.edit(()=>putRecord(session.doc,next,record.revision));session.undo.stopCapturing(); };
  const swap = async () => {
    if (!record.anchor || !session.doc.has(record.anchor.paragraphId)) throw new Error("The source paragraph was deleted. Reattach this alternative before using it.");
    const p = session.doc.paragraph(record.anchor.paragraphId), before = plainText(p.runs), version=session.version;
    if (!["action","dialogue","parenthetical","lyrics"].includes(p.type)) throw new Error("The source is no longer a compatible writing element.");
    const answer = await messageBox({ type:"question",message:"Swap this alternative into the screenplay?",detail:"The current wording will become the stored alternative. This is one undoable edit.",buttons:["Swap","Cancel"],defaultId:1,cancelId:1 });
    if(answer!==0)return;
    if(app.session!==session || session.version!==version)throw new Error("The draft changed. Review the current wording before swapping.");
    session.undo.stopCapturing();session.edit(()=>{
      const latest=session.doc.meta.get(RECORD_PREFIX+record.id) as ProjectRecord|undefined;
      if(latest?.revision!==record.revision)throw new Error("The alternative changed. Reopen it first.");
      session.doc.replaceText(p.id,0,before.length,record.text);
      putRecord(session.doc,{...record,text:before,anchor:anchorAt(session.doc,{paragraphId:p.id,offset:0},{paragraphId:p.id,offset:record.text.length})},record.revision);
    });session.undo.stopCapturing();
  };
  return <article className={`rewrite-item ${record.resolved ? "resolved" : ""}`}>
    <h3>{record.title || (record.kind === "note" ? "Note" : record.kind === "cut" ? "Saved passage" : "Untitled")}</h3>
    <small>{record.author ? `${record.author} · ` : ""}{new Date(record.created).toLocaleString()}{record.resolved ? " · Resolved" : ""}{record.anchor && !target ? " · Orphaned anchor" : ""}</small>
    <p>{record.text}</p>{record.paragraphs && <pre className="rewrite-excerpt">{record.paragraphs.map((p)=>plainText(p.runs)).join("\n\n")}</pre>}
    <div className="rewrite-actions">
      {record.anchor && <button className="button" disabled={!target} onClick={()=>reveal(record)}>Go to text</button>}
      <button className="button" disabled={session.readOnly} onClick={()=>app.openModal("rewrite.edit",{sessionId:session.id,record})}>Edit</button>
      {record.kind === "note" && <><button className="button" disabled={session.readOnly} onClick={()=>run(()=>update({...record,resolved:!record.resolved}))}>{record.resolved ? "Reopen" : "Resolve"}</button>
        <button className="button" disabled={session.readOnly} onClick={()=>app.openModal("rewrite.edit",{sessionId:session.id,isNew:true,record:createRecord("note",`Reply: ${record.title || "Note"}`,"",{parentId:record.id,anchor:record.anchor,author:app.setting("collab.name","Writer")})})}>Reply</button></>}
      {record.anchor && <button className="button" disabled={session.readOnly || !app.editor} onClick={()=>run(()=>{ const id=app.editor?.currentParagraphId();if(!id)throw new Error("Place the caret first.");update({...record,anchor:anchorAt(session.doc,{paragraphId:id,offset:0})}); })}>Attach at caret</button>}
      {record.kind === "alternative" && <button className="button" disabled={session.readOnly || !target} onClick={()=>void swap().catch((e)=>setError(String(e)))}>Swap into draft…</button>}
      {record.kind === "cut" && <button className="button" disabled={session.readOnly || !app.editor} onClick={()=>run(()=>{ if(!record.paragraphs?.length || !app.editor) return;app.editor.insertParagraphs(record.paragraphs.map((p)=>({type:p.type,runs:p.runs})));app.toast("Inserted a copy. The saved cut is still kept.","success"); })}>Insert copy at caret</button>}
      <button className="button" disabled={session.readOnly} onClick={()=>void (async()=>{
        const answer=await messageBox({type:"warning",message:"Remove this project item?",detail:"The screenplay text will not be changed. Undo can restore the item.",buttons:["Keep","Remove"],defaultId:0,cancelId:0});
        if(answer===1)run(()=>{session.undo.stopCapturing();session.edit(()=>{ const current=session.doc.meta.get(RECORD_PREFIX+record.id) as ProjectRecord|undefined;if(current?.revision!==record.revision)throw new Error("This item changed; review it again.");session.doc.meta.delete(RECORD_PREFIX+record.id);});session.undo.stopCapturing();});
      })().catch((e)=>setError(String(e)))}>Remove…</button>
    </div>{error && <p role="alert">{error}</p>}
    {record.kind === "note" && records(session.doc,"note").filter((r)=>r.parentId===record.id).map((reply)=><div className="rewrite-reply" key={reply.id}><strong>{reply.author||"Writer"}</strong><p>{reply.text}</p></div>)}
  </article>;
}
function RewritePanel() {
  useDocVersion(); const session=useSession(), {readOnly}=useSessionState();
  const [kind,setKind]=useState<RecordKind>("note"),[query,setQuery]=useState(""),[showResolved,setShowResolved]=useState(false);
  const items=records(session.doc,kind).filter((r)=>!r.parentId && (showResolved||!r.resolved) && `${r.title} ${r.text}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="rewrite-panel" aria-label="Notes and rewrite material">
    <label className="field"><span>Project material</span><select aria-label="Rewrite material type" value={kind} onChange={(e)=>setKind(e.target.value as RecordKind)}><option value="note">Notes</option><option value="bookmark">Bookmarks</option><option value="alternative">Alternatives</option><option value="cut">Cuts</option></select></label>
    <input type="search" aria-label="Filter project material" placeholder="Filter notes and material" value={query} onChange={(e)=>setQuery(e.target.value)}/>
    {kind==="note" && <label><input type="checkbox" checked={showResolved} onChange={(e)=>setShowResolved(e.target.checked)}/>Include resolved notes</label>}
    {kind==="note" && <p className="empty-note">Notes pinned to a passage, the kind Final Draft shows in the margin, are in <button className="link-button" onClick={()=>app.togglePanel("fdxNotes", true)}>Script Notes</button></p>}
    <button className="button primary" disabled={readOnly} onClick={()=>void app.runCommand(`rewrite.new.${kind}`)}>New {kind === "cut" ? "copy in Cuts" : kind}</button>
    {session.format!=="screenplay" && <p role="status">Save a .screenplay master to preserve these project items. They are excluded from ordinary script exports.</p>}
    {items.map((item)=><ProjectItem key={item.id} record={item}/>)}{!items.length&&<p className="empty-note">No matching material. Add an item without changing the screenplay.</p>}
  </section>;
}
function BeatsView() { useDocVersion();const {readOnly}=useSessionState();return <section className="beats-view"><h2>Unassigned beats</h2><p>Ideas live here until you choose to write them. Adding an idea never inserts a hidden scene.</p><button className="button primary" disabled={readOnly} onClick={()=>openNew("beat")}>New beat</button><div>{records(app.session.doc,"beat").map((record)=><ProjectItem key={record.id} record={record}/>)}</div></section>; }
const feature:Feature={id:"rewrite",panels:[{id:"rewrite",title:"Notes",side:"right",order:5,component:RewritePanel}],views:[{id:"beats",title:"Beats",order:40,component:BeatsView}],modals:[{id:"rewrite.edit",title:"Project note / saved material",width:720,component:EditRecord}],commands:[
  {id:"rewrite.open",label:"Notes, Bookmarks and Alternatives",menu:"Tools",group:"rewrite",run:(a)=>{a.setFocusMode(false);a.togglePanel("rewrite",true);}},
  // A note is a quick capture: a small box that saves as you type and works with the caret anywhere. The form below keeps the title field.
  {id:"rewrite.new.note",label:"New Note",menu:"Tools",group:"rewrite",accelerator:"CmdOrCtrl+Shift+M",enabled:()=>!app.session.readOnly,run:()=>openQuickNote()},
  {id:"rewrite.new.note.form",label:"New Note with Title…",menu:"Tools",group:"rewrite",enabled:()=>!app.session.readOnly&&!!app.editor&&!inOtherTextField(),run:()=>openNew("note")},
  ...(["bookmark","cut","alternative","beat"] as RecordKind[]).map((kind)=>({id:`rewrite.new.${kind}`,label:kind==="cut"?"Save Selected Passage to Cuts…":`New ${kind[0]!.toUpperCase()+kind.slice(1)}…`,menu:"Tools" as const,group:"rewrite",...(kind==="bookmark"?{accelerator:"CmdOrCtrl+Shift+B"}:{}),enabled:()=>!app.session.readOnly&&(kind==="beat"||!!app.editor)&&!inOtherTextField(),run:()=>openNew(kind)})),
]};
export default feature;
