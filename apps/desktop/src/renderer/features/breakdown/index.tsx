import { scenesOf, TAG_CATEGORIES } from "@screenplay/engine";
import { useSyncExternalStore } from "react";
import { judgesWholeScript, WHOLE_SCRIPT_NEEDS } from "../../../shared/channels/ai.ts";
import { app, type Feature } from "../../core/app.ts";
import { useScript, useSessionState } from "../../core/hooks.ts";
import { Boundary } from "../assistant/Boundary.tsx";
import { providerName } from "../assistant/provider.ts";
import { openAiSetup } from "../assistant/setup.ts";
import { categoryClass } from "./highlights.ts";
import { BreakdownStore, showTags } from "./store.ts";
import "./breakdown.css";

const store = new BreakdownStore();

function BreakdownPanel() {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const script = useScript(), { readOnly } = useSessionState(), scenes = scenesOf(script.paragraphs), scene = scenes[store.sceneIndex];
  const checked = store.rows.filter(row => row.checked).length;
  return <div className="breakdown-panel">
    <div className="breakdown-controls">
      <p className="breakdown-scene">{scene ? `Scene ${scene.number || store.sceneIndex + 1}: ${scene.heading || "Untitled scene"}` : "Place the caret in a scene."}</p>
      <p className="breakdown-note">Suggestions from {providerName(store.resultProvider ?? store.provider)}. Cast comes from character cues.</p>
      {store.resultProvider && store.resultProvider !== store.provider && <p className="breakdown-note">Next request uses {providerName(store.provider)}.</p>}
      <button className="button" disabled={!scene || store.busy} onClick={() => void store.suggest(false)}>Suggest for this scene</button>
      <button className="button" disabled={!scenes.length || store.busy || !judgesWholeScript(store.provider)} onClick={() => void store.suggest(true)}>Suggest for every scene</button>
      {!judgesWholeScript(store.provider) && <span className="assistant-needs">{WHOLE_SCRIPT_NEEDS}</span>}
      {store.busy && <div className="breakdown-progress" role="status"><span>{store.progress || "Preparing suggestions…"}</span><button className="button" onClick={store.cancel}>Cancel</button></div>}
      {store.all && <p className="breakdown-note">Reviewing suggestions from all scenes. Tag selected applies checked elements across these scenes.</p>}
      {store.error && <p role="alert" className="breakdown-error">{store.error} {store.setupRequired && <button className="button" onClick={openAiSetup}>Set up AI…</button>}</p>}
      {store.message && <p role="status" className="breakdown-note">{store.message}</p>}
    </div>
    <div className="breakdown-list">
      {TAG_CATEGORIES.map(([category]) => {
        const rows = store.rows.filter(row => row.category === category);
        return rows.length ? <section key={category} className={categoryClass(category)}><h3>{category}</h3>{rows.map(row => <div key={row.id} className="breakdown-row" onFocus={() => store.reveal(row)} onClick={() => store.reveal(row)}>
          <input type="checkbox" aria-label={`Tag ${row.label}`} checked={row.checked} onChange={e => store.update(row.id, { checked: e.target.checked })}/>
          <div className="breakdown-element"><input type="text" aria-label={`Element name for ${row.quote}`} maxLength={200} value={row.label} onChange={e => store.update(row.id, { label: e.target.value })}/>
            <select aria-label={`Category for ${row.label}`} value={row.category} onChange={e => store.update(row.id, { category: e.target.value })}>
              {TAG_CATEGORIES.map(([name]) => <option key={name} value={name}>{name}</option>)}
            </select>
            <q>{row.quote}</q>{store.all && <span className="breakdown-note">Scene {row.sceneIndex + 1}</span>}
          </div>
        </div>)}</section> : null;
      })}
      {!store.rows.length && !store.busy && <p className="breakdown-note">Speaking cast appears here automatically. Suggest adds other production elements for review.</p>}
    </div>
    <div className="breakdown-actions">
      {readOnly && <p className="breakdown-note">This script is read-only. Tagging is disabled.</p>}
      <button className="button primary" disabled={readOnly || store.busy || !checked} onClick={store.tag}>Tag selected{checked ? ` (${checked})` : ""}</button>
      <button className="button" disabled={store.sceneIndex < 0 || !scenes[store.sceneIndex + 1]} onClick={store.next}>Next scene</button>
    </div>
  </div>;
}

function Panel() { return <Boundary label="Breakdown"><BreakdownPanel /></Boundary>; }

const feature: Feature = {
  id: "breakdown",
  panels: [{ id: "breakdown", title: "Breakdown", side: "right", order: 55, component: Panel }],
  commands: [
    { id: "breakdown.suggest", label: "Suggest Breakdown Tags…", menu: "Tools", group: "production", run: a => { a.flushPending(); a.togglePanel("breakdown", true); } },
    { id: "breakdown.showTags", label: "Show Breakdown Tags", menu: "View", group: "production", checked: showTags, run: async a => { await a.setSetting("breakdown.showTags", !showTags()); a.refreshMenu(); } },
  ],
  activate: () => store.start(),
};
export default feature;
