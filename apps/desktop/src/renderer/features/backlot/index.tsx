import { ProductionPanel } from "./production-panel.tsx";
import { planGroups } from "./plan-text.ts";
import { currentPagination } from "../print/live.ts";
import { currentRevisionSet, productionSnapshot, revisionLabel, revisionState, type BacklotBaseline, type ProductionSnapshot, writeFdx } from "@screenplay/engine";
import { acceptProductionBaseline, sessionBaseline } from "./baseline.ts";
import { useState } from "react";
import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { desktop } from "../../core/platform.ts";
import type { BacklotPlan, ImportOptions, PlanRow } from "../../../shared/channels/backlot.ts";
import type { DocumentSession } from "../../core/session.ts";
// Backlot requires a label for every import; start from the current revision's name, or the date.
const defaultLabel = (session: DocumentSession) => { const set = currentRevisionSet(revisionState(session.doc)); return set ? revisionLabel(set) : `Cold Open draft ${new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" })}`; };
function Bridge({ close }: ModalProps) {
    const [session] = useState(app.session), [connection, setConnection] = useState<{
        title: string;
        project: string;
        projectId: string;
    } | null>(null), [plan, setPlan] = useState<BacklotPlan | null>(null), [captured, setCaptured] = useState<{
        xml: string;
        version: number;
        current: ProductionSnapshot;
        baseline: BacklotBaseline | null;
    } | null>(null), [options, setOptions] = useState<ImportOptions>({ castMode: "add", revisionLabel: defaultLabel(session), omitSceneIds: [], sceneDecisions: [] }), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState("");
    const run = (fn: () => Promise<void>) => { if (busy)
        return; setBusy(true); setError(""); void fn().catch(e => setError(String(e))).finally(() => setBusy(false)); };
    const change = (next: ImportOptions) => { setOptions(next); setDirty(true); };
    const preview = async () => { if (app.session !== session)
        throw new Error("The open document changed. Reopen the handoff."); app.flushPending(); const source = captured ?? { xml: writeFdx(session.script()), version: session.version, current: productionSnapshot(session.script(), currentPagination(app)), baseline: sessionBaseline(session, connection?.projectId) }; const result = await desktop.invoke<BacklotPlan>("backlot:preview", source.xml, options, { baseline: source.baseline, current: source.current }); setCaptured(source); setPlan(result); setDirty(false); setDone(""); };
    return <div className="roadmap-dialog"><p>Open the production project in Backlot first. This handoff uses its existing reviewed import, keeps matched scene identities, and leaves missing scenes active unless you explicitly choose to omit them.</p><button className="button" disabled={busy} onClick={() => run(async () => { const c = await desktop.invoke<{
        title: string;
        project: string;
        projectId: string;
    } | null>("backlot:choose"); if (c) {
        setConnection(c);
        setPlan(null);
        setCaptured(null);
        setOptions({ castMode: "add", revisionLabel: defaultLabel(session), omitSceneIds: [], sceneDecisions: [] });
    } })}>Choose open Backlot project…</button>{connection && <p><strong>{connection.title}</strong><br />{connection.project}</p>}
    <label className="field"><span>Cast reconciliation</span><select aria-label="Backlot cast mode" value={options.castMode} disabled={busy} onChange={e => change({ ...options, castMode: e.target.value as ImportOptions["castMode"] })}><option value="add">Add script cast; keep existing cast</option><option value="none">Leave cast assignments unchanged</option><option value="sync">Synchronize script cast, including removals</option></select></label><label className="field"><span>Revision label</span><input aria-label="Backlot revision label" maxLength={120} value={options.revisionLabel} onChange={e => change({ ...options, revisionLabel: e.target.value })}/></label>
    <p>Preview saves an immutable FDX copy in the selected project’s .inklot-drafts folder. It does not change the production project. These source copies are retained, not silently pruned.</p><button className="button primary" disabled={busy || !connection || !options.revisionLabel.trim()} onClick={() => run(preview)}>{busy ? "Working…" : captured ? "Review revised choices" : "Preview captured draft"}</button>
    {plan && <section><h3>Reviewed project revision {plan.revision}</h3><p>{plan.addedElements} added elements · {plan.removedElements} removed elements. The import uses merge mode to retain manual breakdown data.</p>
      {plan.unresolved.map(row => <label className="field" key={row.incomingNumber}><span>{row.incomingNumber} · {row.heading} — {row.reason}</span><select aria-label={`Match draft scene ${row.incomingNumber}`} value={(() => { const d = options.sceneDecisions.find(d => d.incomingNumber === row.incomingNumber); return d ? d.action === "new" ? "new" : `match:${d.sceneId}` : ""; })()} onChange={e => change({ ...options, sceneDecisions: [...options.sceneDecisions.filter(d => d.incomingNumber !== row.incomingNumber), ...(e.target.value ? [{ incomingNumber: row.incomingNumber, action: e.target.value === "new" ? "new" as const : "match" as const, ...(e.target.value.startsWith("match:") ? { sceneId: e.target.value.slice(6) } : {}) }] : [])] })}><option value="">Choose an identity</option>{row.candidates.map(c => <option key={c.sceneId} value={`match:${c.sceneId}`}>{c.number} · {c.heading}</option>)}<option value="new">Create a new scene</option></select></label>)}
      {((plan.plan.removed ?? []) as PlanRow[]).map(row => row.sceneId && <label key={row.sceneId}><input type="checkbox" checked={options.omitSceneIds.includes(row.sceneId)} onChange={e => change({ ...options, omitSceneIds: e.target.checked ? [...options.omitSceneIds, row.sceneId!] : options.omitSceneIds.filter(id => id !== row.sceneId) })}/>Explicitly omit missing scene {row.number} · {row.heading}</label>)}
      {planGroups(plan.plan, options.castMode).map(group => <details key={group.key}><summary>{group.title} · {group.rows.length}</summary><ul>{group.rows.map((row, i) => <li key={i}>{row}</li>)}</ul></details>)}
      {dirty && <p role="status">Choices changed. Review the updated plan before applying.</p>}<button className="button primary" disabled={busy || dirty || !!plan.unresolved.length} onClick={() => run(async () => { if (app.session !== session || session.readOnly) throw new Error("Reopen the handoff in an editable document."); const result = await desktop.invoke<{
            revision: number;
            project: string;
            baseline: BacklotBaseline;
        } | null>("backlot:apply", plan.id); if (result) {
            await acceptProductionBaseline(session, result.baseline).catch(error => { throw new Error(`Backlot applied the handoff, but its baseline could not be saved: ${String(error)}`); });
            setDone(`Applied to ${result.project}, revision ${result.revision}. Review schedule impacts and Undo in Backlot.`);
            setPlan(null);
            setCaptured(null);
        } })}>Apply reviewed import…</button>
    </section>}{done && <p role="status">{done}</p>}{error && <p role="alert">{error}</p>}<p>No automatic scheduling, call-sheet distribution, or silent AI breakdown is triggered by Cold Open. Backlot’s own enabled synopsis automation may run after an import.</p><div className="modal-actions"><button className="button" disabled={busy} onClick={close}>Close</button></div></div>;
}
const feature: Feature = { id: "backlot-handoff", panels: [{ id: "backlot.productionChanges", title: "Production changes", side: "right", component: ProductionPanel }], commands: [{ id: "backlot.handoff", label: "Review Draft in Backlot…", menu: "File", group: "export", enabled: a => !a.session.readOnly, run: a => a.openModal("backlot.handoff") }], modals: [{ id: "backlot.handoff", title: "Backlot production handoff", width: 900, component: Bridge }] };
export default feature;
