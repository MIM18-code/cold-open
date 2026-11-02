import { structuralMoveScene, type StructuralMoveConflict } from "@screenplay/engine";
import { useState, useSyncExternalStore } from "react";
import { app, type ModalProps } from "../../core/app.ts";
import { useSession } from "../../core/hooks.ts";

function useMoveConflicts() {
  const session = useSession();
  return useSyncExternalStore(listener => {
    const change = session.onChange(listener), state = session.onState(listener);
    return () => { change(); state(); };
  }, () => session.moveConflicts);
}

export function StructuralMoveStatus() {
  const conflicts = useMoveConflicts();
  if (!conflicts.length) return null;
  return <button className="recovery-health recovery-health-error" onClick={() => app.openModal("revisions.moveConflicts")}>
    Your typing was left behind by a co-writer's move · Review
  </button>;
}

export function StructuralMoveConflicts({ close }: ModalProps) {
  const session = useSession(), conflicts = useMoveConflicts();
  const [error, setError] = useState("");
  const showText = (conflict: StructuralMoveConflict) => {
    if (!session.moveTextSelection(conflict)) { setError("That text changed. Review the remaining notices."); return; }
    close(); app.setView("script");
    requestAnimationFrame(() => {
      if (app.session !== session) return;
      const selection = session.moveTextSelection(conflict);
      if (!selection) return;
      app.editor?.revealParagraph(selection.anchor.paragraphId, { select: false, offset: selection.anchor.offset });
      app.editor?.setSelection(selection.anchor, selection.head);
      app.editor?.focus();
    });
  };
  const showScene = (id: string) => {
    close(); app.setView("script");
    requestAnimationFrame(() => { if (app.session === session && session.doc.has(id)) app.editor?.revealParagraph(id); });
  };
  return <div className="roadmap-dialog">
    <p>A co-writer's move left your typing behind; cut and paste it into the moved scene or section.</p>
    {!conflicts.length && <p role="status">No typing left behind to review.</p>}
    {conflicts.map(conflict => {
      const scene = structuralMoveScene(session.doc, conflict), heading = conflict.heading || "Untitled scene or section";
      return <fieldset key={conflict.id}><legend>{heading}</legend>
        <label className="field">Text left at the old position<textarea aria-label={`Text left behind from ${heading}`} readOnly value={conflict.text} rows={4} /></label>
        {scene.reason && <p>{scene.reason}</p>}
        <div className="modal-actions">
          <button className="button" onClick={() => showText(conflict)}>Show where it is now</button>
          <button className="button" disabled={!scene.headingId} title={scene.reason} onClick={() => scene.headingId && showScene(scene.headingId)}>Show the scene</button>
          <button className="button" onClick={() => session.leaveMoveText(conflict.id)}>Leave it here</button>
        </div>
      </fieldset>;
    })}
    {error && <p role="alert">{error}</p>}
    <div className="modal-actions"><button className="button" onClick={close}>Done</button></div>
  </div>;
}
