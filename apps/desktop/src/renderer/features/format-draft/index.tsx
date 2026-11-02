import { useEffect, useState, useSyncExternalStore } from "react";
import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { useEditor, useSessionState, useSetting } from "../../core/hooks.ts";
import { desktop } from "../../core/platform.ts";
import { inOtherTextField } from "../../core/keyboard.ts";
import { buildTakeContext } from "../dictation/context.ts";
import { ELEMENT_LABELS } from "../editor/rules.ts";
import { formatAccelerator } from "../../shell/Shell.tsx";
import { DraftFormatController } from "./controller.ts";
import { hasSelection } from "./target.ts";
import "./format-draft.css";

const SHORTCUT = "CmdOrCtrl+Shift+Enter";
export const draftFormatter = new DraftFormatController({
  session: () => app.session, editor: () => app.editor,
  context: (target) => buildTakeContext(app.session.script(), target.from.paragraphId, target.from.offset),
  invoke: (...args) => desktop.invoke(...args),
  alwaysReview: () => app.setting("draftFormat.alwaysReview", false),
  review: () => app.openModal("format-draft.review"),
  notify: (message, error) => app.toast(message, error ? "error" : "success"),
});
function useDraftFormat() { return useSyncExternalStore(draftFormatter.subscribe, draftFormatter.snapshot); }
function FormatButton() {
  const state = useDraftFormat();
  const editor = useEditor();
  const { readOnly } = useSessionState();
  const [scope,setScope] = useState("current paragraph");
  useEffect(() => {
    const update = () => { const s=editor?.getSelection(); setScope(s && (s.anchor.paragraphId!==s.head.paragraphId || s.anchor.offset!==s.head.offset) ? "selected passage" : "current paragraph"); };
    update(); return editor?.onSelectionChange(update);
  }, [editor]);
  if (!editor) return null;
  return <div className="draft-format-toolbar" role="group" aria-label="Draft formatting">
    <button className="button draft-format-button" disabled={readOnly || state.phase !== "idle"}
      title={`Format ${scope} (${formatAccelerator(app.commands.find((c)=>c.id==="draftFormat.run")?.accelerator ?? SHORTCUT)}). Uses your local dictation model; the original is preserved by Undo.`}
      onMouseDown={(event) => event.preventDefault()} onClick={() => void app.runCommand("draftFormat.run")}>
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12M2 7h7M5 11h9M5 14h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      {state.phase === "working" ? "Formatting…" : "Format Draft"}
      <kbd>{formatAccelerator(app.commands.find((c)=>c.id==="draftFormat.run")?.accelerator ?? SHORTCUT)}</kbd><small className="draft-target-label">{scope}</small>
    </button>
    {state.phase === "working" ? <button className="icon-button" onClick={() => draftFormatter.cancel()}>Cancel</button> : null}
  </div>;
}
function Review({ close }: ModalProps) {
  const state = useDraftFormat();
  const { readOnly } = useSessionState();
  useEffect(() => () => { if (draftFormatter.snapshot().phase === "review") draftFormatter.cancel(); }, []);
  if (!state.take || !state.target) return <p>Your original draft has not been changed.</p>;
  return <div className="draft-format-review">
    <p>The selection will be replaced in the main script as one undoable edit. Nothing else will be changed.</p>
    {!!state.warnings?.length && <div className="draft-format-warnings" role="status"><strong>Check these before applying</strong><ul>{state.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
    <div className="draft-format-columns">
      <section><h3>Original draft</h3><pre>{state.target.text}</pre></section>
      <section><h3>Formatted screenplay</h3>{state.take.elements.map((e, i) => <div className={`draft-format-element draft-format-${e.type}`} key={i}><span>{ELEMENT_LABELS[e.type]}</span><p>{e.text}</p></div>)}</section>
    </div>
    <div className="modal-actions"><button className="button" onClick={close}>Keep original</button><button className="button primary" disabled={readOnly} onClick={() => { if (draftFormatter.apply()) close(); }}>Apply formatting</button></div>
  </div>;
}
function FormatSettings() {
  const [review, setReview] = useSetting("draftFormat.alwaysReview", false);
  return <div><p>Dictate with Wispr Flow, paste a rough passage, or type directly on the page. Select the text and use <strong>Format Draft</strong>.</p>
    <p>Without a selection, only the current paragraph is formatted. The local model configured under Dictation is used; no microphone is required and there is no cloud fallback.</p>
    <label className="field"><span><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> Always preview before replacing the draft</span></label>
    <p>Uncertain results, wording changes and styled text always require review. Source edits, document switches and cancellation prevent a late result from replacing your work.</p>
    <button className="button" onClick={() => app.openModal("workspace.settings", { section: "dictation" })}>Configure local formatter…</button>
  </div>;
}
const feature: Feature = {
  id: "format-draft",
  commands: [{ id: "draftFormat.run", label: "Format Draft Selection / Paragraph", menu: "Format", group: "draft", accelerator: SHORTCUT,
    enabled: (a) => !!a.editor && a.ui.view === "script" && !a.session.readOnly && !a.ui.modal && !inOtherTextField() && draftFormatter.snapshot().phase === "idle",
    run: () => draftFormatter.format() }],
  toolbar: [{ id: "format-draft", order: 30, component: FormatButton }],
  modals: [{ id: "format-draft.review", title: "Review draft formatting", width: 920, component: Review }],
  settings: [{ id: "format-draft", title: "Draft formatting", order: 35, component: FormatSettings }],
  activate(a) {
    const off = a.onSession(() => draftFormatter.cancel());
    const state = draftFormatter.subscribe(() => a.refreshMenu());
    // UI testing uses the same controller; this does not expose any credentials or file access.
    (window as unknown as { __draftFormatter: unknown }).__draftFormatter = draftFormatter;
    return () => { off(); state(); draftFormatter.cancel(); };
  },
};
export { hasSelection };
export default feature;
