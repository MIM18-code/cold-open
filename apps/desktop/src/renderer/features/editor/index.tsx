// The script editor feature: the Script view, Final Draft's element and formatting commands, Undo and
// Redo on the shared document, Find and Replace, dual dialogue, zoom, and the element picker.
import { MARKS, type ElementType, type Mark } from "@screenplay/engine";

import type { App, Command, Feature } from "../../core/app.ts";
import { useSetting } from "../../core/hooks.ts";
import type { DocumentSession } from "../../core/session.ts";
import { inOtherTextField } from "../../core/keyboard.ts";
import { find } from "./find.ts";
import { DEFAULT_NEXT, ELEMENT_LABELS, ELEMENT_SHORTCUTS, dualDialogueChanges, repairMessage } from "./rules.ts";
import { ElementPicker, ElementStatus, MarkButtons, ScriptView, ZOOM_STEPS } from "./view.tsx";
import "./editor.css";

const hasEditor = (a: App) => !!a.editor;
const canEdit = (a: App) => !!a.editor && a.ui.view === "script" && !a.session.readOnly && !a.ui.modal && !inOtherTextField();

function setZoom(a: App, direction: 1 | -1 | 0): void {
  const zoom = a.setting("editor.zoom", 1);
  // A requested percentage means fixed magnification. Opening a sidebar must never override it.
  void a.setSetting("editor.zoomMode", "fixed");
  if (direction === 0) return void a.setSetting("editor.zoom", 1);
  const steps = direction > 0 ? ZOOM_STEPS.filter((step) => step > zoom + 0.001) : ZOOM_STEPS.filter((step) => step < zoom - 0.001).reverse();
  if (steps[0] !== undefined) void a.setSetting("editor.zoom", steps[0]);
}
function ZoomControl() {
  const [zoom, setZoomValue] = useSetting("editor.zoom", 1);
  const [mode, setMode] = useSetting<"fit" | "fixed">("editor.zoomMode", "fit");
  return <label className="editor-zoom-control">
    <span>Zoom</span>
    <select aria-label="Script zoom" value={mode === "fit" ? "fit" : String(zoom)} onChange={(event) => {
      const value = event.target.value;
      if (value === "fit") void setMode("fit");
      else { void setZoomValue(Number(value)); void setMode("fixed"); }
    }}>
      <option value="fit">Fit width</option>
      {ZOOM_STEPS.map((step) => <option key={step} value={step}>{Math.round(step * 100)}%</option>)}
    </select>
  </label>;
}

/**
 * Undo and Redo on the script, when the script (or nothing that takes text) has focus. A read-only script takes
 * nothing back. In a text field outside the script they do nothing: undoing the script from there would change
 * text the writer is not looking at, and a native undo is unsafe because Chromium keeps one undo stack per page,
 * shared with the script's editable text, so it could rewrite the script behind the engine's back.
 */
function undo(a: App, action: "undo" | "redo"): void {
  if (a.session.readOnly || inOtherTextField()) return;
  if (action === "undo") a.session.undo.undo();
  else a.session.undo.redo();
}

/** Make Dual Dialogue: pair the dialogue block at the caret with its neighbour, or split a dual block apart. */
function toggleDualDialogue(a: App): void {
  const selection = a.editor?.getSelection();
  if (!selection) return;
  const doc = a.session.doc;
  const paragraphs = doc.paragraphs();
  const ends = [doc.indexOf(selection.anchor.paragraphId), doc.indexOf(selection.head.paragraphId)].sort((x, y) => x - y);
  const changes = dualDialogueChanges(paragraphs, ends[0]!, ends[1]!);
  if (!changes) {
    a.toast("Put the caret in a character's dialogue that sits next to another character's.", "info");
    return;
  }
  a.session.edit(() => {
    for (const change of changes) doc.setField(change.id, "dual", change.dual);
  });
}

const elementCommands: Command[] = (Object.keys(ELEMENT_LABELS) as ElementType[]).map((type) => {
  const key = ELEMENT_SHORTCUTS.find(([shortcut]) => shortcut === type)?.[1];
  return {
    id: `editor.element.${type}`,
    label: ELEMENT_LABELS[type],
    menu: "Format",
    group: key ? "elements" : "more-elements",
    ...(key ? { accelerator: `CmdOrCtrl+${key}` } : {}),
    enabled: canEdit,
    checked: (a) => a.editor?.currentElementType() === type,
    run: (a) => a.editor?.setElementType(type),
  };
});

const markCommand = (mark: Mark, label: string, key: string): Command => ({
  id: `editor.${mark}`, label, menu: "Format", group: "marks", accelerator: `CmdOrCtrl+${key}`, enabled: canEdit,
  run: (a) => a.editor?.toggleMark(mark),
  checked: (a) => !!a.editor?.activeMarks?.()[mark],
});

function EditorSettings() {
  const [zoom, setZoomSetting] = useSetting("editor.zoom", 1);
  const [zoomMode, setZoomMode] = useSetting<"fit" | "fixed">("editor.zoomMode", "fit");
  const [next, setNext] = useSetting<Partial<Record<ElementType, ElementType>>>("editor.nextElement", {});
  const types = Object.keys(ELEMENT_LABELS) as ElementType[];
  return (
    <div className="editor-settings">
      <label className="field">
        <span>Zoom</span>
        <select aria-label="Script magnification" value={zoomMode === "fit" ? "fit" : String(zoom)} onChange={(event) => {
          if (event.target.value === "fit") void setZoomMode("fit");
          else { void setZoomSetting(Number(event.target.value)); void setZoomMode("fixed"); }
        }}>
          <option value="fit">Fit width (may resize when sidebars open)</option>
          {ZOOM_STEPS.map((step) => <option key={step} value={step}>{Math.round(step * 100)}% (fixed)</option>)}
        </select>
        <small>Fixed percentages stay the same when you open a sidebar. The page scrolls horizontally when necessary.</small>
      </label>
      <div className="field">
        <span>After Return, start a new</span>
        <table className="data">
          <tbody>
            {types.map((type) => (
              <tr key={type}>
                <td>{ELEMENT_LABELS[type]}</td>
                <td>
                  <select aria-label={`After ${ELEMENT_LABELS[type]}`} value={next[type] ?? DEFAULT_NEXT[type]}
                    onChange={(event) => setNext({ ...next, [type]: event.target.value as ElementType })}>
                    {types.map((option) => <option key={option} value={option}>{ELEMENT_LABELS[option]}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const feature: Feature = {
  id: "editor",
  views: [{ id: "script", title: "Script", order: 0, component: ScriptView }],
  commands: [
    { id: "editor.undo", label: "Undo", menu: "Edit", group: "undo", accelerator: "CmdOrCtrl+Z", run: (a) => undo(a, "undo") },
    { id: "editor.redo", label: "Redo", menu: "Edit", group: "undo", accelerator: "CmdOrCtrl+Shift+Z", run: (a) => undo(a, "redo") },
    { id: "editor.find", label: "Find…", menu: "Edit", group: "find", accelerator: "CmdOrCtrl+F", enabled: hasEditor, run: () => find.show(false) },
    { id: "editor.findNext", label: "Find Next", menu: "Edit", group: "find", accelerator: "CmdOrCtrl+G", enabled: hasEditor, run: () => find.next() },
    { id: "editor.findPrevious", label: "Find Previous", menu: "Edit", group: "find", accelerator: "CmdOrCtrl+Shift+G", enabled: hasEditor, run: () => find.next(true) },
    { id: "editor.replace", label: "Find and Replace…", menu: "Edit", group: "find", accelerator: "CmdOrCtrl+Alt+F", enabled: hasEditor, run: () => find.show(true) },
    ...elementCommands,
    markCommand("bold", "Bold", "B"),
    markCommand("italic", "Italic", "I"),
    markCommand("underline", "Underline", "U"),
    { id: "editor.dualDialogue", label: "Make Dual Dialogue", menu: "Script", group: "dialogue", accelerator: "CmdOrCtrl+Alt+D", enabled: canEdit, run: toggleDualDialogue },
    { id: "editor.zoomIn", label: "Zoom In", menu: "View", group: "zoom", accelerator: "CmdOrCtrl+=", run: (a) => setZoom(a, 1) },
    { id: "editor.zoomOut", label: "Zoom Out", menu: "View", group: "zoom", accelerator: "CmdOrCtrl+-", run: (a) => setZoom(a, -1) },
    // Cmd+0 is General, as in Final Draft, so Actual Size adds Option.
    { id: "editor.zoomReset", label: "Actual Size", menu: "View", group: "zoom", accelerator: "CmdOrCtrl+Alt+0", run: (a) => setZoom(a, 0) },
    { id: "editor.zoomFit", label: "Fit Script to Width", menu: "View", group: "zoom", run: (a) => a.setSetting("editor.zoomMode", "fit") },
  ],
  toolbar: [{ id: "editor.element", order: 0, component: ElementPicker }, { id: "editor.marks", order: 1, component: MarkButtons }],
  status: [{ id: "editor.element", order: 0, component: ElementStatus }, { id: "editor.zoom", order: 70, component: ZoomControl }],
  settings: [{ id: "editor", title: "Editor", order: 10, component: EditorSettings }],
  activate(a) {
    // The Format menu's check marks follow the element and the text style at the caret.
    let offSelection: (() => void) | null = null;
    let editor = a.editor;
    let shown = "";
    const watch = () => {
      offSelection?.();
      offSelection = editor?.onSelectionChange(() => {
        const marks = editor?.activeMarks?.() ?? {};
        const current = `${editor?.currentElementType() ?? ""} ${MARKS.filter((mark) => marks[mark]).join(" ")}`;
        if (current !== shown) (shown = current, a.refreshMenu());
      }) ?? null;
    };
    watch();
    a.subscribe(() => {
      if (a.editor === editor) return;
      editor = a.editor;
      watch();
      a.refreshMenu();
    });
    // A read-only follower leaves repairing repeated paragraph IDs to its writers (ScreenplayDoc.setRepairs). A
    // repair keeps both copies of the text, so the writer hears that something is in the script twice.
    let offState = () => {};
    const follow = (session: DocumentSession) => {
      offState();
      const apply = () => session.doc.setRepairs(!session.readOnly);
      apply();
      const offStateChange = session.onState(apply);
      const offRepair = session.doc.onRepair((report) => {
        const message = repairMessage(report);
        if (message) a.toast(message, "info");
      });
      offState = () => (offStateChange(), offRepair());
    };
    follow(a.session);
    a.onSession(follow);
  },
};

export default feature;
