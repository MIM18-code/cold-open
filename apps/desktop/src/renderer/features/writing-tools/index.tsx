import { plainText, scenesOf } from "@screenplay/engine";
import { useState } from "react";
import { CHANNELS } from "../../../shared/api.ts";
import { app, type App, type Feature, type ModalProps } from "../../core/app.ts";
import { useApp, useSetting } from "../../core/hooks.ts";
import { inOtherTextField } from "../../core/keyboard.ts";
import { desktop } from "../../core/platform.ts";
import { formatAccelerator } from "../../shell/Shell.tsx";
import { currentPagination } from "../print/live.ts";
import "./writing-tools.css";
const inScript = (a: App) => !!a.editor && a.ui.view === "script" && !a.ui.modal && !inOtherTextField();
function sceneAtCaret(a: App) {
  const script = a.session.script();
  const scenes = scenesOf(script.paragraphs);
  const caret = a.editor?.currentParagraphId();
  const index = scenes.findIndex((s) => s.paragraphIds.includes(caret ?? ""));
  return { script, scenes, index };
}
function moveScene(a: App, direction: number) {
  const { scenes, index } = sceneAtCaret(a);
  const next = scenes[Math.min(scenes.length - 1, Math.max(0, index + direction))];
  if (next) a.editor?.revealParagraph(next.headingId, { select: true });
}
function selectScene(a: App) {
  const { scenes, index, script } = sceneAtCaret(a);
  const scene = scenes[index];
  if (!scene) return;
  const last = script.paragraphs[scene.end - 1]!;
  a.editor?.setSelection({ paragraphId: scene.headingId, offset: 0 }, { paragraphId: last.id, offset: plainText(last.runs).length });
  a.editor?.focus();
}
function GoToPage({ close }: ModalProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const pages = currentPagination(app).pages;
  const go = () => {
    const page = pages.find((p) => p.number.toUpperCase() === value.trim().toUpperCase());
    const line = page?.lines.find((l) => !l.generated && l.paragraphId);
    if (!line) return setError("Enter a page number in this script, including an A-page suffix when applicable.");
    close();
    app.editor?.revealParagraph(line.paragraphId, { select: true, offset: line.from });
  };
  return <form onSubmit={(e) => { e.preventDefault(); go(); }}><label className="field"><span>Page number</span><input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={pages[0]?.number ?? "1"} /></label>
    <p>{pages.length} pages. Locked numbers such as 12A are supported.</p>{error && <p role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="button" onClick={close}>Cancel</button><button className="button primary" type="submit">Go to page</button></div></form>;
}
function Shortcuts() {
  const [query, setQuery] = useState("");
  const commands = app.commands.filter((c) => c.accelerator && !c.hidden && `${c.label} ${c.menu ?? ""} ${c.accelerator}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="writing-shortcuts"><input className="input" autoFocus aria-label="Search shortcuts" placeholder="Search actions, dialogue, navigation…" value={query} onChange={(e) => setQuery(e.target.value)} />
    <p><kbd>Enter</kbd> advances to the next screenplay element. <kbd>Tab</kbd> and <kbd>Shift Tab</kbd> use the editor’s element flow. Pick an exact element with the shortcuts below.</p>
    <table className="data"><tbody>{commands.map((c) => <tr key={c.id}><td>{c.label}<small>{c.menu}</small></td><td><kbd>{formatAccelerator(c.accelerator!)}</kbd></td></tr>)}</tbody></table>
    {!commands.length && <p>No matching shortcuts.</p>}</div>;
}
function WritingSettings() {
  const [typewriter, setTypewriter] = useSetting("editor.typewriter", false);
  const [tabs, setTabs] = useSetting("workspace.openInTabs", true);
  return <div><label className="field"><span><input type="checkbox" checked={typewriter} onChange={(e) => setTypewriter(e.target.checked)} /> Keep the writing line near the center (typewriter mode)</span></label>
    {desktop.platform === "darwin" && <label className="field"><span><input type="checkbox" checked={tabs} onChange={(e) => setTabs(e.target.checked)} /> Open additional scripts in native document tabs</span></label>}
    <p>Focus mode hides the sidebars without changing their contents. Escape brings them back. Each document tab keeps its own save state and undo history.</p>
    <button className="button" onClick={() => app.openModal("writing.shortcuts")}>Keyboard shortcuts…</button></div>;
}
function WritingToolbar() {
  const focused = useApp((a) => !!a.ui.focusMode);
  return <div className="writing-tools-toolbar"><button className={`button ${focused ? "on" : ""}`} aria-pressed={focused} title={`Focus mode (${formatAccelerator("CmdOrCtrl+Shift+F")})`} onMouseDown={(e) => e.preventDefault()} onClick={() => void app.runCommand("writing.focus")}>{focused ? "Exit Focus" : "Focus"}</button>
    <button className="icon-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={() => app.openModal("writing.shortcuts")}>?</button></div>;
}
const feature: Feature = {
  id: "writing-tools",
  commands: [
    { id: "writing.focus", label: "Focus Mode", menu: "View", group: "writing", accelerator: "CmdOrCtrl+Shift+F", checked: (a) => !!a.ui.focusMode, run: (a) => a.setFocusMode(!a.ui.focusMode) },
    { id: "writing.typewriter", label: "Typewriter Mode", menu: "View", group: "writing", checked: (a) => a.setting("editor.typewriter", false), run: (a) => a.setSetting("editor.typewriter", !a.setting("editor.typewriter", false)) },
    // Navigate among work regions without tabbing through every toolbar button or scene.
    { id: "writing.focusScript", label: "Focus Script", menu: "View", group: "focus", accelerator: "CmdOrCtrl+Alt+1",
      run: (a) => { a.setView("script"); requestAnimationFrame(() => a.editor?.focus()); } },
    { id: "writing.focusScenes", label: "Focus Scene Navigator", menu: "View", group: "focus", accelerator: "CmdOrCtrl+Alt+2",
      run: (a) => {
        a.setFocusMode(false); a.togglePanel("navigator", true);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.navigator-list [data-scene-id][tabindex="0"]')?.focus());
      } },
    { id: "writing.focusInspector", label: "Focus Right Inspector", menu: "View", group: "focus", accelerator: "CmdOrCtrl+Alt+3",
      run: (a) => {
        const panel = a.ui.rightPanel ?? a.panels.find((p) => p.side === "right")?.id;
        if (!panel) return;
        a.setFocusMode(false); a.togglePanel(panel, true);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('.sidepanel-right [role="tabpanel"] input, .sidepanel-right [role="tabpanel"] button, .sidepanel-right [role="tab"]')?.focus());
      } },
    { id: "writing.selectScene", label: "Select Current Scene", menu: "Edit", group: "selection", accelerator: "CmdOrCtrl+Shift+A", enabled: inScript, run: selectScene },
    { id: "writing.previousScene", label: "Previous Scene", menu: "View", group: "navigate", accelerator: "CmdOrCtrl+Alt+Up", enabled: inScript, run: (a) => moveScene(a, -1) },
    { id: "writing.nextScene", label: "Next Scene", menu: "View", group: "navigate", accelerator: "CmdOrCtrl+Alt+Down", enabled: inScript, run: (a) => moveScene(a, 1) },
    { id: "writing.goToPage", label: "Go to Page…", menu: "View", group: "navigate", accelerator: "CmdOrCtrl+Alt+G", enabled: inScript, run: (a) => a.openModal("writing.page") },
    { id: "writing.shortcuts", label: "Keyboard Shortcuts…", menu: "Tools", group: "help", accelerator: "CmdOrCtrl+/", run: (a) => a.openModal("writing.shortcuts") },
    ...(desktop.platform === "darwin" ? [
      { id: "writing.newTab", label: "New Document Tab", menu: "File" as const, group: "files", accelerator: "CmdOrCtrl+T", run: () => desktop.invoke(CHANNELS.newTab) },
      { id: "writing.nextTab", label: "Next Document Tab", menu: "View" as const, group: "tabs", accelerator: "Ctrl+Tab", run: () => desktop.invoke(CHANNELS.tabAction, "next") },
      { id: "writing.previousTab", label: "Previous Document Tab", menu: "View" as const, group: "tabs", accelerator: "Ctrl+Shift+Tab", run: () => desktop.invoke(CHANNELS.tabAction, "previous") },
    ] : []),
  ],
  modals: [{ id: "writing.shortcuts", title: "Keyboard shortcuts", width: 640, component: Shortcuts }, { id: "writing.page", title: "Go to page", width: 420, component: GoToPage }],
  toolbar: [{ id: "writing-tools", order: 100, component: WritingToolbar }],
  settings: [{ id: "writing", title: "Writing & navigation", order: 15, component: WritingSettings }],
};
export default feature;
