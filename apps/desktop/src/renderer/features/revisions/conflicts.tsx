import {
  dismissSceneNumberRenumberings, issuedSceneNumbers, replaceSceneNumber, sceneNumberConflicts, sceneNumberRenumberings,
} from "@screenplay/engine";
import { useState } from "react";
import { app, type ModalProps } from "../../core/app.ts";
import { useScript, useSession } from "../../core/hooks.ts";

export function SceneNumberStatus() {
  const session = useSession(), script = useScript(500), conflicts = sceneNumberConflicts(script.paragraphs);
  const renumbered = sceneNumberRenumberings(session.doc);
  if (!conflicts.length && !renumbered.length) return null;
  return (
    <button className="recovery-health recovery-health-error" onClick={() => app.openModal("revisions.numberConflicts")}>
      {conflicts.length ? "Scene-number conflict · Review" : "Scene numbers adjusted · Review"}
    </button>
  );
}

export function SceneNumberConflicts({ close }: ModalProps) {
  const session = useSession(), script = useScript(0), conflicts = sceneNumberConflicts(script.paragraphs);
  const renumbered = sceneNumberRenumberings(session.doc), issued = issuedSceneNumbers(session.doc);
  const [values, setValues] = useState<Record<string, string>>({}), [error, setError] = useState("");
  const apply = (id: string, old: string) => {
    try {
      if (app.session !== session || session.readOnly) throw new Error("Choose an editable draft.");
      session.undo.stopCapturing();
      session.edit(() => replaceSceneNumber(session.doc, id, old, values[id] ?? old));
      session.undo.stopCapturing(); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const reveal = (id: string) => { close(); app.setView("script"); requestAnimationFrame(() => app.editor?.revealParagraph(id)); };
  return <div className="roadmap-dialog">
    {renumbered.length > 0 && <fieldset><legend>Renumbered to remove a duplicate</legend>
      <p>Two writers added a scene in the same locked gap, or a locked draft already used a number. The later scene in the script gets the next free number; every other number stayed as it was.</p>
      {renumbered.map((change) => <div className="field" key={change.id}>
        <button type="button" className="button" onClick={() => reveal(change.id)}>{change.heading || "Untitled scene"}</button>
        <span>{change.from} → {change.to}</span>
      </div>)}
      <button type="button" className="button" disabled={session.readOnly} onClick={() => session.edit(() => dismissSceneNumberRenumberings(session.doc))}>Dismiss notice</button>
    </fieldset>}
    <p>Concurrent additions or an imported draft can assign one number to multiple scenes. Coordinate any change to published production numbers with your production team.</p>
    {!conflicts.length && <p role="status">Every assigned scene number is unique.</p>}
    {conflicts.map((conflict) => <fieldset key={conflict.number}><legend>Duplicate {conflict.number}</legend>{conflict.headings.map((h) => {
      const old = script.paragraphs.find((p) => p.id === h.id)?.sceneNumber ?? "";
      return <form className="field" key={h.id} onSubmit={(e) => { e.preventDefault(); if (!session.readOnly && values[h.id] && values[h.id] !== old) apply(h.id, old); }}><button type="button" className="button" onClick={() => reveal(h.id)}>{h.heading || "Untitled scene"}</button>
        {issued.get(h.id) === conflict.number && <span>Issued in the last locked Final Draft draft.</span>}
        <label>New number for {h.heading || "untitled scene"}<input aria-label={`New number for ${h.heading || "untitled scene"}`} maxLength={24} value={values[h.id] ?? old} disabled={session.readOnly} onChange={(e) => setValues({ ...values, [h.id]: e.target.value })}/></label>
        <button type="submit" className="button" disabled={session.readOnly || !values[h.id] || values[h.id] === old}>Apply this number</button></form>;
    })}</fieldset>)}
    {error && <p role="alert">{error}</p>}<div className="modal-actions"><button className="button" onClick={close}>Done</button></div>
  </div>;
}
