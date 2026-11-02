import { characterName, plainText, type Paragraph } from "@screenplay/engine";
import { useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { useDocVersion, useScript, useSession } from "../../core/hooks.ts";
import { replaceInDocument } from "../editor/replace.ts";
import { revealScene } from "../navigator/structure-data.ts";
import { dialogueDraft, dialogueDraftRecords, discardDialogueDraft, saveDialogueDraft } from "./drafts.ts";
import "../rewrite/rewrite.css";

interface Speech { paragraph: Paragraph; character: string; scene: string; before: string; after: string; }
export function dialogueSpeeches(paragraphs: readonly Paragraph[]): Speech[] {
  const out: Speech[] = []; let character="", scene="Before first scene";
  paragraphs.forEach((p,i)=>{
    if(p.type==="sceneHeading"){scene=plainText(p.runs);character="";}
    else if(p.type==="character")character=characterName(plainText(p.runs));
    else if((p.type==="dialogue"||p.type==="lyrics")&&character)out.push({paragraph:p,character,scene,before:paragraphs[i-1]?plainText(paragraphs[i-1]!.runs):"",after:paragraphs[i+1]?plainText(paragraphs[i+1]!.runs):""});
    else if(!["parenthetical","note","synopsis"].includes(p.type))character="";
  });return out;
}
function SpeechEditor({ speech, recordId, draftNumber }: {
  speech: Speech; recordId?: string; draftNumber?: number;
}) {
  const session = useSession();
  useDocVersion();
  const original = session.doc.has(speech.paragraph.id) ? plainText(session.doc.paragraph(speech.paragraph.id).runs) : "";
  const saved = dialogueDraft(session, speech.paragraph.id, recordId);
  const base = saved?.base ?? original, text = saved?.text ?? original;
  const [error, setError] = useState("");
  const conflict = base !== original;
  const apply = () => {
    try {
      if (app.session !== session || !session.doc.has(speech.paragraph.id) || conflict) {
        throw new Error("The source changed. Reload before saving.");
      }
      session.edit(() => {
        replaceInDocument(session, speech.paragraph.id, 0, base.length, text);
        discardDialogueDraft(session, speech.paragraph.id, recordId);
      });
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  const discard = () => {
    discardDialogueDraft(session, speech.paragraph.id, recordId);
    setError("");
  };
  return <article className="dialogue-edit">
    <h3>{speech.character} · {speech.scene}</h3><small>Before: {speech.before.slice(0, 240)}</small>
    {draftNumber !== undefined && <p>Draft {draftNumber}. Co-writers saved separate versions of this speech.</p>}
    <textarea aria-label={`Dialogue for ${speech.character}`} value={text} readOnly={session.readOnly} maxLength={20000}
      onChange={(e) => saveDialogueDraft(session, speech.paragraph.id, base, e.target.value, recordId)}/>
    <small>After: {speech.after.slice(0, 240)}</small>
    {conflict && <p role="status">The source changed while you were editing. Copy your draft or reload the current wording.</p>}
    <div className="dialogue-actions">
      <button className="button primary" disabled={session.readOnly || conflict || text === base} onClick={apply}>
        Apply to script
      </button>
      <button className="button" disabled={session.readOnly} onClick={discard}>Reload / discard local edits</button>
      <button className="button" onClick={() => {
        app.closeModal();
        revealScene(speech.paragraph.id);
      }}>Go to script</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </article>;
}
function DialogueDesk() {
  const session = useSession(), script = useScript(200);
  const [character, setCharacter] = useState(""), [query, setQuery] = useState("");
  const rows = dialogueSpeeches(script.paragraphs);
  const names = [...new Set(rows.map(s => s.character))].sort();
  return <section className="dialogue-desk">
    <p>Edit the actual source paragraphs. Changes preserve the screenplay’s undo and production-revision handling;
      field drafts are retained in .screenplay files and crash recovery until Apply or discard.
      Save a .screenplay master to keep them.</p>
    <label className="field"><span>Character</span>
      <select aria-label="Dialogue review character" value={character} onChange={(e) => setCharacter(e.target.value)}>
        <option value="">All characters</option>{names.map(name => <option key={name}>{name}</option>)}
      </select>
    </label>
    <input type="search" aria-label="Filter dialogue review" placeholder="Filter dialogue" value={query} onChange={(e)=>setQuery(e.target.value)}/>
    {rows.filter(s => (!character || s.character === character)
      && plainText(s.paragraph.runs).toLowerCase().includes(query.toLowerCase())).flatMap(speech => {
        const drafts = dialogueDraftRecords(session, speech.paragraph.id);
        return drafts.length ? drafts.map((draft, index) => <SpeechEditor
          key={drafts.length === 1 ? speech.paragraph.id : draft.id} speech={speech} recordId={draft.id}
          draftNumber={drafts.length > 1 ? index + 1 : undefined}/>)
          : [<SpeechEditor key={speech.paragraph.id} speech={speech}/>];
      })}
  </section>;
}
const feature:Feature={id:"dialogue-desk",commands:[{id:"dialogue.review",label:"Edit Character Dialogue…",menu:"Tools",group:"rewrite",run:(a)=>{a.flushPending();a.openModal("dialogue.review");}}],modals:[{id:"dialogue.review",title:"Character dialogue review",width:920,component:DialogueDesk}]};
export default feature;
