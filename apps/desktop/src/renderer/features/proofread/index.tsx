// Proofreading: always on, suggestions only. The engine's checks and the macOS spell checker run a moment after
// the script changes; findings are underlined in the script and listed in the Proofread panel, where the writer
// accepts or ignores each one. "Check with AI" adds typo and continuity findings the same way.
import { useSyncExternalStore } from "react";

import type { Feature } from "../../core/app.ts";
import { Boundary } from "../assistant/Boundary.tsx";
import { ProofreadPanel } from "./Panel.tsx";
import { ProofreadStore } from "./store.ts";
import "./proofread.css";
import { app } from "../../core/app.ts";

let store: ProofreadStore | null = null;
const getStore = () => (store ??= new ProofreadStore(app));

function Panel() {
  return <Boundary label="Proofread"><ProofreadPanel store={getStore()} /></Boundary>;
}

function StatusButton() {
  const current = getStore();
  useSyncExternalStore(current.subscribe, current.getVersion);
  const count = current.findings.length;
  return (
    <button className="icon-button" title="Show proofreading suggestions" onClick={() => app.togglePanel("proofread")}>
      {count ? `${count} to proofread` : "Proofread"}
    </button>
  );
}

function Status() {
  return <Boundary label="Proofread"><StatusButton /></Boundary>;
}

const feature: Feature = {
  id: "proofread",
  panels: [{ id: "proofread", title: "Proofread", side: "right", order: 50, component: Panel }],
  status: [{ id: "proofread", order: 80, component: Status }],
  commands: [
    { id: "proofread.next", label: "Next Proofreading Suggestion", menu: "Tools", group: "proofread", accelerator: "CmdOrCtrl+;", run: () => getStore().next(1) },
    { id: "proofread.previous", label: "Previous Proofreading Suggestion", menu: "Tools", group: "proofread", run: () => getStore().next(-1) },
    { id: "proofread.checkScene", label: "Check Scene with AI", menu: "Tools", group: "proofread", run: (a) => (a.togglePanel("proofread", true), getStore().checkWithAi("scene")) },
    { id: "proofread.checkScript", label: "Check Script with AI", menu: "Tools", group: "proofread", run: (a) => (a.togglePanel("proofread", true), getStore().checkWithAi("script")) },
  ],
  activate: () => getStore().start(),
};

export default feature;
