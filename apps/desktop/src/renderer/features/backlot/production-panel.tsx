import { backlotChanges, productionSnapshot, type ProductionChange } from "@screenplay/engine";
import { useEffect, useState, useSyncExternalStore } from "react";
import { sessionBaseline, subscribeBaseline } from "./baseline.ts";
import { app } from "../../core/app.ts";
import { useScript, useSession, useSessionState } from "../../core/hooks.ts";
import { desktop } from "../../core/platform.ts";
import { useCurrentPagination } from "../print/live.ts";
import { revealScene } from "../navigator/structure-data.ts";
import { reviewForChange, type BacklotProductionState } from "../../../shared/channels/backlot.ts";
import "./production.css";

function details(change: ProductionChange): string[] {
  const { before, after, kinds } = change;
  const lines: string[] = [];
  if (kinds.includes("added")) lines.push("Added");
  if (kinds.includes("omitted")) lines.push(after ? "Omitted" : "Omitted (removed from script)");
  if (kinds.includes("restored")) lines.push("Restored");
  if (kinds.includes("moved")) lines.push(`Moved: ${change.previousPosition} → ${change.position}`);
  if (kinds.includes("heading")) lines.push(`Heading: ${before!.heading} → ${after!.heading}`);
  if (kinds.includes("characters")) {
    const added = after!.characters.filter(c => !before!.characters.includes(c));
    const removed = before!.characters.filter(c => !after!.characters.includes(c));
    if (added.length) lines.push(`Characters added: ${added.join(", ")}`);
    if (removed.length) lines.push(`Characters removed: ${removed.join(", ")}`);
  }
  if (kinds.includes("tags")) {
    const changed = (a: NonNullable<typeof before>, b: NonNullable<typeof before>) => a.tags.filter(t => !b.tags.some(u => JSON.stringify(t) === JSON.stringify(u))).map(t => `${t.category}: ${t.label}`);
    const added = changed(after!, before!), removed = changed(before!, after!);
    if (added.length) lines.push(`Tags added: ${added.join(", ")}`);
    if (removed.length) lines.push(`Tags removed: ${removed.join(", ")}`);
  }
  if (kinds.includes("length")) lines.push(`Length: ${before!.eighths}/8 → ${after!.eighths}/8 (${change.eighthsDelta > 0 ? "+" : ""}${change.eighthsDelta}/8)`);
  return lines;
}

export function ProductionPanel() {
  const { readOnly } = useSessionState();
  const session = useSession(), script = useScript(), pagination = useCurrentPagination(script);
  const baseline = useSyncExternalStore(subscribeBaseline, () => sessionBaseline(session));
  const changes = backlotChanges(baseline, productionSnapshot(script, pagination));
  const [state, setState] = useState<{ session: typeof session; value: BacklotProductionState | null; error: string } | null>(null);
  useEffect(() => {
    let stopped = false, reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await desktop.invoke<BacklotProductionState | null>("backlot:production-state");
        if (!stopped) setState({ session, value, error: "" });
      } catch {
        if (!stopped) setState({ session, value: null, error: "Backlot production state unavailable." });
      } finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [session]);
  const production = state?.session === session ? state : null;
  const matchingProject = !baseline || production?.value?.projectId === baseline.projectId;
  return <div className="production-changes" aria-label="Production changes">
    <div className="production-changes-actions"><button className="button" disabled={readOnly} onClick={() => app.openModal("backlot.handoff")}>Review in Backlot…</button></div>
    <p className="empty-note">{baseline ? "Changes since you last sent this script to Backlot." : "Not sent to Backlot yet, so every scene is new."}</p>
    {production?.error && <p role="status" className="empty-note">{production.error}</p>}
    {production && !production.error && !production.value && <p className="empty-note">Choose a Backlot project to check schedule impacts.</p>}
    {!matchingProject && production?.value && <p className="empty-note">The selected Backlot project differs from the last handoff.</p>}
    <div className="production-changes-list">{changes.scenes.map(change => {
      const scene = change.after ?? change.before!;
      const review = reviewForChange(matchingProject ? production?.value ?? null : null, change);
      return <button key={change.sceneId} className="production-change" disabled={!change.after} onClick={() => change.after && revealScene(change.after.headingId)}>
        <strong>{scene.number ?? change.position ?? change.previousPosition} · {scene.heading || "Untitled scene"}</strong>
        {details(change).map(line => <span key={line}>{line}</span>)}
        {review.needsBacklotReview && <span className="production-review">Needs Backlot review{review.issuedCallSheet ? " · issued call sheet" : " · scheduled"}</span>}
        {!change.after && <span>Scene no longer in script.</span>}
      </button>;
    })}</div>
    {!changes.scenes.length && <p className="empty-note">No production changes.</p>}
  </div>;
}
