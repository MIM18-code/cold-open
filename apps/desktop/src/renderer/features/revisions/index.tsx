// Production revisions: Revision Mode (Final Draft's Track Revisions), revision sets and their colors, clearing
// marks, locked pages and locked scene numbers. The rules live in the engine (revisions.ts, pagination.ts and the
// scene numbering in structure.ts); tracking.ts marks changes as they are made, marks.ts draws them.
import {
  clearRevisionMarks, currentRevisionSet, fdxExtras, isOmitted, lockPages, newRevisionSet, omitScene, omittedParagraphs, pageLocks,
  revisionColor, revisionDate, revisionLabel, revisionState, sceneNumbersLocked, setSceneNumbersLocked, unlockPages, unomitScene,
  updateRevisionState, type Paragraph, type RevisionSet, type RevisionState, type Scene,
} from "@screenplay/engine";
import { useMemo, useState, useSyncExternalStore } from "react";

import { app, type App, type Feature, type ModalProps } from "../../core/app.ts";
import { useSession } from "../../core/hooks.ts";
import type { DocumentSession } from "../../core/session.ts";
import { paginateForPrint, readPrintSettings } from "../print/options.ts";
import { revisionDecorations, revisionStyles } from "./marks.ts";
import { trackSession } from "./tracking.ts";
import "./revisions.css";
import { StructuralMoveConflicts, StructuralMoveStatus } from "./move-conflicts.tsx";
import { SceneNumberConflicts, SceneNumberStatus } from "./conflicts.tsx";

const SOURCE = "revisions";
const DELAY = 150;

/** The open document's revision state, re-read on every document change. */
function useRevisionState(): RevisionState {
  const session = useSession();
  return useSyncExternalStore((onChange) => session.onChange(onChange), () => revisionState(session.doc));
}

function usePageLocked(): boolean {
  const session = useSession();
  return useSyncExternalStore((onChange) => session.onChange(onChange), () => !!pageLocks(session.doc)?.length);
}

/**
 * Production settings (Revision Mode, the sets, locks) are not edits to the script: they save with it and sync
 * to co-writers, but Undo leaves them alone, so undoing a typo never turns Revision Mode off.
 */
const SETTINGS_ORIGIN = "revisions-settings";

function settle<T>(target: App, apply: () => T): T {
  let result!: T;
  target.session.doc.ydoc.transact(() => {
    result = apply();
  }, SETTINGS_ORIGIN);
  target.refreshMenu();
  return result;
}

function change(target: App, update: (state: RevisionState) => Partial<RevisionState>): RevisionState {
  return settle(target, () => updateRevisionState(target.session.doc, update));
}

/** Turn Revision Mode on or off. Turning it on with no revision set starts the first one (Blue). */
function toggleTracking(target: App): void {
  const state = revisionState(target.session.doc);
  if (state.tracking) {
    change(target, () => ({ tracking: false }));
    return;
  }
  if (currentRevisionSet(state)) {
    change(target, () => ({ tracking: true }));
    return;
  }
  const set = state.sets.at(-1) ?? newRevisionSet(state);
  change(target, (current) => ({ sets: current.sets.includes(set) ? current.sets : [...current.sets, set], currentSetId: set.id, tracking: true }));
  target.toast(`Revision Mode is on: ${revisionLabel(set)}`, "info");
}

function addSet(target: App, set: RevisionSet): void {
  change(target, (state) => ({ sets: [...state.sets, set], currentSetId: set.id, tracking: true }));
}

function lockScriptPages(target: App): void {
  const session = target.session;
  const pagination = paginateForPrint(session.script(), readPrintSettings(target.settings), pageLocks(session.doc));
  const locks = settle(target, () => lockPages(session.doc, pagination));
  target.toast(`Locked ${locks.length} ${locks.length === 1 ? "page" : "pages"}. Changes now flow onto A-pages.`, "success");
}

function sceneAtCaret(target: App): Scene | undefined {
  const id = target.editor?.currentParagraphId();
  if (!id) return undefined;
  return target.session.doc.scenes().find((scene) => scene.paragraphIds.includes(id));
}

/** The OMITTED heading of the scene at the caret, when it keeps text to restore. */
function omittedAtCaret(target: App): string | undefined {
  const scene = sceneAtCaret(target);
  if (!scene) return undefined;
  const heading = target.session.doc.paragraph(scene.headingId);
  return isOmitted(heading) && omittedParagraphs(heading).length ? heading.id : undefined;
}

function omitSceneAtCaret(target: App): void {
  const scene = sceneAtCaret(target);
  if (!scene || isOmitted(target.session.doc.paragraph(scene.headingId))) return;
  target.session.edit(() => omitScene(target.session.doc, scene.sceneId));
  const name = scene.number ? `Scene ${scene.number}` : "The scene";
  target.toast(`${name} is omitted. Its text is kept with the OMITTED heading; Restore Omitted Scene brings it back.`, "info");
}

// ----- The Revisions dialog --------------------------------------------------------------------------------

/** Colors for the picker: White, the first round and the second. */
const COLOR_CHOICES = Array.from({ length: 17 }, (_, index) => revisionColor(index));

function NewSetForm({ state, onCreate }: { state: RevisionState; onCreate: (set: RevisionSet) => void }) {
  const suggested = useMemo(() => newRevisionSet(state), [state]);
  const [color, setColor] = useState(COLOR_CHOICES.findIndex((choice) => choice.value === suggested.color && suggested.name.startsWith(choice.name)));
  const [name, setName] = useState(suggested.name);
  const [date, setDate] = useState(revisionDate());
  const [mark, setMark] = useState("*");
  const pick = (index: number) => {
    const previous = COLOR_CHOICES[color];
    // A name still following the color follows the new one.
    if (!previous || name === `${previous.name} Rev.`) setName(`${COLOR_CHOICES[index]!.name} Rev.`);
    setColor(index);
  };
  const create = () => {
    const choice = COLOR_CHOICES[color] ?? revisionColor(state.sets.length + 1);
    onCreate({ ...suggested, name: name.trim() || `${choice.name} Rev.`, color: choice.value, date: date.trim(), mark: mark.trim() || "*" });
  };
  return (
    <form className="revisions-new" onSubmit={(event) => { event.preventDefault(); create(); }}>
      <label className="field">
        <span>Color</span>
        <select name="color" value={color} onChange={(event) => pick(Number(event.target.value))}>
          {COLOR_CHOICES.map((choice, index) => <option key={choice.name} value={index}>{choice.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Name</span>
        <input name="name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span>Date</span>
        <input name="date" value={date} placeholder="10/30/26" onChange={(event) => setDate(event.target.value)} />
      </label>
      <label className="field">
        <span>Mark</span>
        <input name="mark" value={mark} maxLength={2} onChange={(event) => setMark(event.target.value)} />
      </label>
      <div className="modal-actions" style={{ gridColumn: "1 / -1", marginTop: 0 }}>
        <button type="submit" className="button primary">Create revision set</button>
      </div>
    </form>
  );
}

function RevisionsModal({ close, props }: ModalProps<{ mode?: "new" | "clear" } | undefined>) {
  const state = useRevisionState();
  const [adding, setAdding] = useState(props?.mode === "new" || !state.sets.length);
  const clear = (setId: string | null) => {
    const count = app.session.edit(() => clearRevisionMarks(app.session.doc, setId));
    app.toast(count ? "Cleared the revision marks. Undo brings them back." : "There were no revision marks to clear.", count ? "success" : "info");
  };
  return (
    <div className="revisions-form">
      <div className="revisions-checks">
        <label className="revisions-check">
          <input type="checkbox" name="tracking" checked={state.tracking} onChange={() => toggleTracking(app)} />
          <span>Revision Mode</span>
        </label>
        <label className="revisions-check">
          <input type="checkbox" name="showMarks" checked={state.showMarks} onChange={(event) => change(app, () => ({ showMarks: event.target.checked }))} />
          <span>Show revision marks</span>
        </label>
      </div>
      {state.sets.length ? (
        <ul className="revisions-list">
          {state.sets.map((set) => (
            <li key={set.id} className={`revisions-row${set.id === state.currentSetId ? " current" : ""}`} data-set={set.id}>
              <input type="radio" name="current" aria-label={`Use ${set.name}`} checked={set.id === state.currentSetId}
                onChange={() => change(app, () => ({ currentSetId: set.id }))} />
              <span className="revisions-swatch" style={{ background: set.color }} />
              <span className="revisions-row-name">{revisionLabel(set)}</span>
              <span className="revisions-row-meta">{set.mark}</span>
              <button type="button" className="button" onClick={() => clear(set.id)}>Clear marks</button>
            </li>
          ))}
        </ul>
      ) : <p className="revisions-empty">No revision sets yet.</p>}
      {adding
        ? <NewSetForm state={state} onCreate={(set) => (addSet(app, set), setAdding(false))} />
        : <button type="button" className="button" onClick={() => setAdding(true)}>New revision set…</button>}
      <div className="modal-actions">
        {state.sets.length ? <button type="button" className="button" onClick={() => clear(null)}>Clear all marks</button> : null}
        <button type="button" className="button primary" autoFocus={!adding} onClick={close}>Done</button>
      </div>
    </div>
  );
}

// ----- Status bar ------------------------------------------------------------------------------------------

function RevisionStatus() {
  const state = useRevisionState();
  const locked = usePageLocked();
  const set = currentRevisionSet(state);
  if (!state.tracking && !locked) return null;
  return (
    <button type="button" className="revisions-status" title="Revisions" onClick={() => app.openModal("revisions.manage")}>
      {state.tracking && set ? <><span className="revisions-swatch" style={{ background: set.color }} />{revisionLabel(set)}</> : null}
      {locked ? <span>{state.tracking ? "· " : ""}Pages locked</span> : null}
    </button>
  );
}

// ----- Marks in the editor ---------------------------------------------------------------------------------

/** Keep the editor's revision marks and the per-set styles current. Returns a function that stops. */
function startMarks(target: App): () => void {
  const style = document.createElement("style");
  style.dataset.feature = "revisions";
  document.head.append(style);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let editor = target.editor;
  let css = "";
  let drawn = false;
  const draw = () => {
    clearTimeout(timer);
    const doc = target.session.doc;
    const state = revisionState(doc);
    const next = revisionStyles(state);
    if (next !== css) style.textContent = css = next;
    const script = { paragraphs: doc.paragraphs() as Paragraph[], fdx: fdxExtras(doc) };
    const decorations = revisionDecorations(script, state);
    // A script with no revisions (most of them) never touches the editor's decorations.
    if (decorations.length || drawn) target.editor?.setDecorations(SOURCE, decorations);
    drawn = decorations.length > 0;
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, DELAY);
  };
  let offChange = target.session.onChange(schedule);
  let offTracking = trackSession(target.session);
  const offSession = target.onSession((session: DocumentSession) => {
    offChange();
    offTracking();
    offChange = session.onChange(schedule);
    offTracking = trackSession(session);
    draw();
  });
  const offApp = target.subscribe(() => {
    if (target.editor === editor) return;
    editor = target.editor;
    drawn = false;
    if (editor) draw();
  });
  draw();
  return () => {
    clearTimeout(timer);
    offChange();
    offTracking();
    offSession();
    offApp();
    style.remove();
  };
}

const state = (a: App) => revisionState(a.session.doc);

const feature: Feature = {
  id: "revisions",
  commands: [
    { id: "revisions.moveConflicts", label: "Scene Move Conflicts…", menu: "Production", group: "locking", run: (a) => a.openModal("revisions.moveConflicts") },
    { id: "revisions.numberConflicts", label: "Scene Number Conflicts…", menu: "Production", group: "locking", run: (a) => a.openModal("revisions.numberConflicts") },
    { id: "revisions.mode", label: "Revision Mode", menu: "Production", group: "revisions", run: (a) => toggleTracking(a), checked: (a) => state(a).tracking },
    { id: "revisions.current", label: "Current Revision…", menu: "Production", group: "revisions", run: (a) => a.openModal("revisions.manage") },
    { id: "revisions.newSet", label: "New Revision Set…", menu: "Production", group: "revisions", run: (a) => a.openModal("revisions.manage", { mode: "new" }) },
    {
      id: "revisions.clear", label: "Clear Revision Marks…", menu: "Production", group: "revisions",
      enabled: (a) => state(a).sets.length > 0, run: (a) => a.openModal("revisions.manage", { mode: "clear" }),
    },
    {
      id: "revisions.showMarks", label: "Show Revision Marks", menu: "Production", group: "revisions",
      checked: (a) => state(a).showMarks, run: (a) => change(a, (current) => ({ showMarks: !current.showMarks })),
    },
    { id: "revisions.lockPages", label: "Lock Pages", menu: "Production", group: "locking", run: (a) => lockScriptPages(a) },
    {
      id: "revisions.unlockPages", label: "Unlock Pages", menu: "Production", group: "locking",
      enabled: (a) => !!pageLocks(a.session.doc)?.length,
      run: (a) => {
        settle(a, () => unlockPages(a.session.doc));
        a.toast("Unlocked the pages. Pages number 1 to N again.", "info");
      },
    },
    {
      id: "revisions.lockScenes", label: "Lock Scene Numbers", menu: "Production", group: "locking",
      checked: (a) => sceneNumbersLocked(a.session.doc),
      run: (a) => {
        const locked = !sceneNumbersLocked(a.session.doc);
        settle(a, () => setSceneNumbersLocked(a.session.doc, locked));
        a.toast(locked ? "Scene numbers are locked. New scenes get A-numbers." : "Scene numbers are unlocked. Number Scenes renumbers them.", "info");
      },
    },
    {
      id: "revisions.omitScene", label: "Omit Scene", menu: "Production", group: "locking",
      enabled: (a) => !!sceneAtCaret(a) && !omittedAtCaret(a), run: (a) => omitSceneAtCaret(a),
    },
    {
      id: "revisions.restoreScene", label: "Restore Omitted Scene", menu: "Production", group: "locking",
      enabled: (a) => !!omittedAtCaret(a),
      run: (a) => {
        const heading = omittedAtCaret(a);
        if (heading && a.session.edit(() => unomitScene(a.session.doc, heading))) a.toast("Restored the omitted scene.", "success");
      },
    },
  ],
  modals: [{ id: "revisions.moveConflicts", title: "Review text left behind by a move", width: 660, component: StructuralMoveConflicts }, { id: "revisions.numberConflicts", title: "Review scene number conflicts", width: 660, component: SceneNumberConflicts }, { id: "revisions.manage", title: "Revisions", width: 520, component: RevisionsModal }],
  status: [{ id: "revisions.moveConflicts", order: 58, component: StructuralMoveStatus }, { id: "revisions.numberConflicts", order: 59, component: SceneNumberStatus }, { id: "revisions", order: 60, component: RevisionStatus }],
  activate: (a) => startMarks(a),
};

export default feature;
