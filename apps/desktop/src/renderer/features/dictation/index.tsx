// Built-in dictation continues in the editor; the panel holds takes that need review.
import { useEffect, useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { useEditor, useSessionState } from "../../core/hooks.ts";
import { hasSelection } from "../format-draft/target.ts";
import { formatAccelerator } from "../../shell/Shell.tsx";
import { DictationPanel, MicIcon, SHORTCUT } from "./Panel.tsx";
import { DictationSettings } from "./Settings.tsx";
import * as controller from "./controller.ts";
import { store, useDictation } from "./store.ts";
import "./dictation.css";

function ToolbarButton() {
  const { phase, seconds, stage, replacing } = useDictation();
  const editor = useEditor();
  const { readOnly } = useSessionState();
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    const update = () => setSelected(hasSelection(editor?.getSelection()));
    update();
    return editor?.onSelectionChange(update);
  }, [editor]);
  const recording = phase === "recording";
  const busy = phase === "working";
  return (
    <div className="dictation-toolbar-group" role="group" aria-label="Dictation">
    <button className="button" disabled={!editor || readOnly || recording || busy} onMouseDown={event => event.preventDefault()}
      title="Move to the end of the script for typing or Wispr Flow. Format dictated text with Format Draft."
      onClick={controller.continueAtEnd}>Continue at end</button>
    <button className={`button dictation-toolbar ${recording ? "on" : ""}`} aria-pressed={recording} disabled={busy || (!recording && (readOnly || !editor))}
      title={`${recording ? "Stop" : selected ? "Dictate over selected text with review" : "Dictate at end of script"} (${formatAccelerator(SHORTCUT)})`}
      onMouseDown={event => event.preventDefault()}
      onClick={() => void controller.toggleRecording()}>
      <MicIcon /><span>{recording ? "Stop" : selected ? "Dictate selection" : "Dictate"}</span>
    </button>
    {recording || busy ? <span className="dictation-toolbar-status" role="status">{recording
      ? `Listening ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}${replacing ? " · selected text" : " · end of script"}`
      : `${stage}…`}</span> : null}
    </div>
  );
}

const feature: Feature = {
  id: "dictation",
  commands: [
    { id: "dictation.toggle", label: "Start/Stop Dictation", menu: "Tools", group: "dictation", accelerator: SHORTCUT,
      checked: () => store.state.phase === "recording", run: () => controller.toggleRecording() },
    { id: "dictation.continue", label: "Continue at End of Script", menu: "Tools", group: "dictation",
      enabled: a => !!a.editor && a.ui.view === "script" && !a.session.readOnly && !a.ui.modal,
      run: controller.continueAtEnd },
  ],
  panels: [{ id: "dictation", title: "Dictate", side: "right", order: 40, component: DictationPanel }],
  toolbar: [{ id: "dictation", order: 60, component: ToolbarButton }],
  settings: [{ id: "dictation", title: "Dictation", order: 40, component: DictationSettings }],
  activate() {
    controller.startListening();
    app.onSession(() => controller.resetForNewDocument());
    // The menu shows a check mark while recording, so refresh it when the phase changes (including a time-limit stop).
    let phase = store.state.phase;
    store.subscribe(() => {
      if (store.state.phase !== phase) {
        phase = store.state.phase;
        app.refreshMenu();
      }
    });
    // Tests and the developer console reach the workflow here; there is no microphone in tests.
    (window as unknown as { __dictation: unknown }).__dictation = { store, ...controller };
  },
};

export default feature;
