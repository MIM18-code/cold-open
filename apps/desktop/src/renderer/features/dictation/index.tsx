// Dictation: record or paste a take, see it formatted as screenplay elements, and insert what is right.
// Everything is a proposal until the writer presses Insert or Accept.
import { app, type Feature } from "../../core/app.ts";
import { formatAccelerator } from "../../shell/Shell.tsx";
import { DictationPanel, MicIcon, SHORTCUT } from "./Panel.tsx";
import { DictationSettings } from "./Settings.tsx";
import * as controller from "./controller.ts";
import { store, useDictation } from "./store.ts";
import "./dictation.css";

function ToolbarButton() {
  const { phase } = useDictation();
  const recording = phase === "recording";
  return (
    <button className={`button dictation-toolbar ${recording ? "on" : ""}`} aria-pressed={recording} disabled={phase === "working"}
      title={`${recording ? "Stop" : "Start"} dictation (${formatAccelerator(SHORTCUT)})`}
      onClick={() => void controller.toggleRecording()}>
      <MicIcon /><span>{recording ? "Stop" : "Dictate"}</span>
    </button>
  );
}

const feature: Feature = {
  id: "dictation",
  commands: [
    { id: "dictation.toggle", label: "Start/Stop Dictation", menu: "Tools", group: "dictation", accelerator: SHORTCUT,
      checked: () => store.state.phase === "recording", run: () => controller.toggleRecording() },
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
