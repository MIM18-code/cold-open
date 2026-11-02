import { countWords } from "@screenplay/engine";
import { useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { useScript, useSession, useSetting } from "../../core/hooks.ts";
import type { DocumentSession } from "../../core/session.ts";
const baselines = new WeakMap<DocumentSession, number>();
function Goal() { const [enabled] = useSetting("personal.goals", false); return enabled ? <GoalValue /> : null; }
function GoalValue() { const s = useSession(), script = useScript(700), [target] = useSetting("personal.wordGoal", 500); const words = script.paragraphs.filter(p => !["note", "section", "synopsis"].includes(p.type)).reduce((n, p) => n + countWords(p.runs.filter(r => !r.note).map(r => r.text).join("")), 0); if (!baselines.has(s))
    baselines.set(s, words); const delta = words - baselines.get(s)!; return <span title="Private net word change for this document session. Revisions and deletions may lower it.">Session: {delta >= 0 ? "+" : ""}{delta} / {target} words</span>; }
function preset(name: "writing" | "rewriting" | "rehearsal") { app.setFocusMode(false); app.setView("script"); if (app.ui.leftPanel)
    app.togglePanel(app.ui.leftPanel, false); if (app.ui.rightPanel)
    app.togglePanel(app.ui.rightPanel, false); app.togglePanel("navigator", true); if (name === "rewriting")
    app.togglePanel("rewrite", true); if (name === "rehearsal")
    app.togglePanel("tableRead", true); }
function Settings() { const [enabled, setEnabled] = useSetting("personal.goals", false), [target, setTarget] = useSetting("personal.wordGoal", 500), [custom, setCustom] = useSetting<{
    view: string;
    left: string | null;
    right: string | null;
    focus: boolean;
} | null>("personal.workspace", null), [note, setNote] = useState(""); return <div className="roadmap-dialog"><h3>Workspace presets</h3><div>{(["writing", "rewriting", "rehearsal"] as const).map(name => <button className="button" key={name} onClick={() => preset(name)}>{name}</button>)}</div><button className="button" onClick={() => { void setCustom({ view: app.ui.view, left: app.ui.leftPanel, right: app.ui.rightPanel, focus: !!app.ui.focusMode }); setNote("Workspace saved locally. Document contents are unchanged."); }}>Save current workspace</button><button className="button" disabled={!custom} onClick={() => { if (!custom)
    return; app.setFocusMode(custom.focus); if (app.views.some(v => v.id === custom.view))
    app.setView(custom.view); if (app.ui.leftPanel)
    app.togglePanel(app.ui.leftPanel, false); if (app.ui.rightPanel)
    app.togglePanel(app.ui.rightPanel, false); if (custom.left)
    app.togglePanel(custom.left, true); if (custom.right)
    app.togglePanel(custom.right, true); }}>Restore saved workspace</button>{note && <p role="status">{note}</p>}<h3>Optional private session goal</h3><label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>Show a word goal in the status bar</label>{enabled && <label>Session word target<input aria-label="Session word target" type="number" min={1} max={100000} value={target} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 100000)
    void setTarget(n); }}/></label>}<p>Off by default. Turning goals off removes their display and counting component. There are no streaks, reminders, analytics or story judgments. Counts are net document changes, not a measure of writing quality.</p></div>; }
const feature: Feature = { id: "personal", settings: [{ id: "personal", title: "Workspace & optional goals", order: 60, component: Settings }], status: [{ id: "personal.goal", order: 70, component: Goal }], commands: (["writing", "rewriting", "rehearsal"] as const).map(name => ({ id: `workspace.preset.${name}`, label: `${name[0]!.toUpperCase() + name.slice(1)} Workspace`, menu: "View" as const, group: "workspace-presets", run: () => preset(name) })) };
export default feature;
