// Script > Rename Character: pick a character, type the new name, see how many cues and mentions change, apply as one undoable edit.
import { applyTextEdits, characterName, characterReport, planRename, plainText } from "@screenplay/engine";
import { useEffect, useMemo, useRef, useState } from "react";

import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { useScript, useSessionState } from "../../core/hooks.ts";
import { useCurrentPagination } from "../print/live.ts";
import "./rename.css";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The character under the caret, when the caret is in a cue. */
function currentCharacter(): string {
  const id = app.editor?.currentParagraphId();
  const paragraph = id ? app.session.script().paragraphs.find((p) => p.id === id) : undefined;
  return paragraph?.type === "character" ? characterName(plainText(paragraph.runs)) : "";
}

function RenameModal({ close, props }: ModalProps<{ name?: string } | undefined>) {
  const script = useScript();
  const pagination = useCurrentPagination(script);
  const characters = useMemo(() => characterReport(script, pagination), [script, pagination]);
  const [selected, setSelected] = useState(() => characterName(props?.name ?? currentCharacter()));
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => void (selected && input.current?.focus()), [selected]);

  const plan = useMemo(() => (selected ? planRename(script, selected, name) : null), [script, selected, name]);
  const exists = !!name.trim() && name.trim().toUpperCase() !== selected && characters.some((c) => c.name === characterName(name));
  const shown = characters.filter((c) => c.name.includes(filter.trim().toUpperCase()));
  const readOnly = useSessionState().readOnly;
  const canApply = !readOnly && !!plan && plan.edits.length > 0;

  const apply = () => {
    // Plan again against the document as it is now, in case it changed while the dialog was open.
    const session = app.session;
    const fresh = planRename(session.script(), selected, name);
    if (!fresh.edits.length) return;
    session.edit(() => applyTextEdits(session.doc, fresh.edits));
    app.toast(`Renamed ${selected} to ${fresh.upper}: ${plural(fresh.cues, "cue")}, ${plural(fresh.mentions, "mention")}.`, "success");
    close();
  };

  return (
    <div className="rename">
      <label className="field">
        <span>Character</span>
        <input value={filter} placeholder="Filter" aria-label="Filter characters" onChange={(event) => setFilter(event.target.value)} />
      </label>
      <div className="rename-list" role="listbox" aria-label="Characters">
        {shown.map((c) => (
          <div key={c.name} role="option" aria-selected={c.name === selected} className={`list-row rename-row ${c.name === selected ? "on" : ""}`}
            onClick={() => setSelected(c.name)}>
            <span>{c.name}</span>
            <span className="rename-count">{c.speaking ? `${c.speeches} ${c.speeches === 1 ? "speech" : "speeches"}` : "action only"}</span>
          </div>
        ))}
        {!shown.length ? <div className="empty-note">{characters.length ? "No character matches." : "This script has no characters yet."}</div> : null}
      </div>
      <label className="field">
        <span>New name</span>
        <input ref={input} value={name} disabled={!selected || readOnly} aria-label="New name" onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && canApply && apply()} />
      </label>
      <div className="rename-preview" aria-live="polite">
        {readOnly ? "This script is read-only." : !selected ? "Choose a character." : !name.trim() ? `Type a new name for ${selected}.` : !plan?.edits.length
          ? `Nothing to change for ${selected}.`
          : `${plural(plan.cues, "cue")} and ${plural(plan.mentions, "mention")} in ${plural(plan.paragraphs, "paragraph")} will change. Names in caps become ${plan.upper}, and in normal text ${plan.proper}.`}
        {exists ? <div className="rename-warn">{name.trim().toUpperCase()} is already a character. Renaming merges the two.</div> : null}
      </div>
      <div className="modal-actions">
        <button className="button" onClick={close}>Cancel</button>
        <button className="button primary" disabled={!canApply} onClick={apply}>Rename</button>
      </div>
    </div>
  );
}

const feature: Feature = {
  id: "rename",
  commands: [
    { id: "rename.open", label: "Rename Character…", menu: "Script", group: "characters", enabled: (a) => !a.session.readOnly,
      run: (a) => a.openModal("rename.main") },
  ],
  modals: [{ id: "rename.main", title: "Rename Character", width: 480, component: RenameModal }],
};

export default feature;
