import { useState, useSyncExternalStore } from "react";
import { app, type Feature } from "../../core/app.ts";
import { useSession, useSetting } from "../../core/hooks.ts";
import { autosaveNative } from "../file/index.tsx";
import type { DocumentSession } from "../../core/session.ts";
interface State {
    busy: boolean;
    error: string;
    at: number;
}
const empty: State = { busy: false, error: "", at: 0 }, states = new WeakMap<DocumentSession, State>(), listeners = new Set<() => void>();
function update(s: DocumentSession, value: State) { states.set(s, value); for (const fn of listeners)
    fn(); }
async function run() { const s = app.session, previous = states.get(s) ?? empty; if (previous.busy)
    return; update(s, { ...previous, busy: true, error: "" }); try {
    const saved = await autosaveNative();
    update(s, { busy: false, error: "", at: saved ? Date.now() : previous.at });
}
catch (e) {
    update(s, { ...previous, busy: false, error: String(e) });
} }
function Status() { const s = useSession(), state = useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => states.get(s) ?? empty); return state.error ? <button className="button" title={state.error} onClick={() => app.openModal("workspace.settings", { section: "autosave" })}>Autosave paused · review</button> : null; }
function Settings() { const [enabled, setEnabled] = useSetting("file.nativeAutosave", false), s = useSession(), state = useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => states.get(s) ?? empty); return <div><label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>Autosave an already-saved .screenplay master every 30 seconds</label><p>Off by default. Native masters only, after the first explicit Save. Recovery copies and draft history are separate. Another app’s changed file pauses autosave instead of being overwritten. FDX and Fountain are never autosaved.</p>{state.at > 0 && <p>Last native autosave: {new Date(state.at).toLocaleTimeString()}</p>}{state.error && <p role="alert">{state.error}</p>}<button className="button" disabled={state.busy || s.format !== "screenplay" || !s.path} onClick={() => void run()}>Retry native autosave</button><button className="button" onClick={() => void app.runCommand("file.save")}>Save / resolve file conflict…</button></div>; }
const feature: Feature = { id: "native-autosave", settings: [{ id: "autosave", title: "Native autosave", order: 19, component: Settings }], status: [{ id: "autosave.status", order: 2, component: Status }], activate(a) { const timer = setInterval(() => { const state = states.get(a.session); if (a.setting("file.nativeAutosave", false) && !state?.error && !state?.busy)
        void run(); }, 30000); return () => clearInterval(timer); } };
export default feature;
