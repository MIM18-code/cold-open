import { useRef, useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { useDocVersion, useSession, useSessionState } from "../../core/hooks.ts";
import { records, type ProjectRecord } from "../rewrite/records.ts";
import { scenesOf } from "@screenplay/engine";
import { revealScene } from "../navigator/structure-data.ts";
import { CANVAS_PREFIX, placement, placeBeat, type BeatPlacement } from "./model.ts";
import "./canvas.css";
function BeatCard({ record, index, spatial, zoom }: {
    record: ProjectRecord;
    index: number;
    spatial: boolean;
    zoom: number;
}) {
    const session = useSession(), position = placement(session.doc.meta.get(CANVAS_PREFIX + record.id), index), [draft, setDraft] = useState<BeatPlacement | null>(null), [error, setError] = useState("");
    const drag = useRef<{
        x: number;
        y: number;
        position: BeatPlacement;
    } | null>(null), display = draft ?? position;
    const apply = (next: BeatPlacement, expected = position.revision) => { try {
        if (app.session !== session)
            throw new Error("The document changed.");
        session.undo.stopCapturing();
        session.edit(() => placeBeat(session.doc, record.id, next, expected));
        session.undo.stopCapturing();
        setError("");
    }
    catch (e) {
        setError(String(e));
    }
    finally {
        setDraft(null);
    } };
    const scenes = scenesOf(session.doc.paragraphs()), linked = scenes.find((s) => s.sceneId === position.sceneId);
    return <article className="beat-spatial-card" style={spatial ? { position: "absolute", left: display.x, top: display.y, width: 260 } : undefined}>
    <button className="beat-move-handle" disabled={session.readOnly} aria-label={`Move beat ${record.title || "Untitled"}`} title="Drag, or use arrow keys; Shift moves ten pixels" onPointerDown={(e) => { if (e.button !== 0)
        return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, position }; }} onPointerMove={(e) => { const start = drag.current; if (start)
        setDraft({ ...start.position, x: Math.max(0, Math.min(2800, start.position.x + (e.clientX - start.x) / zoom)), y: Math.max(0, Math.min(1800, start.position.y + (e.clientY - start.y) / zoom)) }); }} onPointerUp={(e) => { const start = drag.current; drag.current = null; if (start) {
        apply({ ...start.position, x: start.position.x + (e.clientX - start.x) / zoom, y: start.position.y + (e.clientY - start.y) / zoom }, start.position.revision);
        e.currentTarget.releasePointerCapture(e.pointerId);
    } }} onPointerCancel={() => { drag.current = null; setDraft(null); }} onKeyDown={(e) => { const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key]; if (!delta)
        return; e.preventDefault(); const step = e.shiftKey ? 10 : 1; apply({ ...position, x: position.x + delta[0]! * step, y: position.y + delta[1]! * step }); }}>Move · {record.title || "Untitled beat"}</button>
    <p>{record.text}</p><label>Lane / storyline <input aria-label={`Lane for ${record.title || "Untitled"}`} maxLength={80} defaultValue={position.lane} key={position.revision} disabled={session.readOnly} onBlur={(e) => { if (e.target.value !== position.lane)
        apply({ ...position, lane: e.target.value }); }}/></label>
    <label>Link to scene <select aria-label={`Scene for ${record.title || "Untitled"}`} value={position.sceneId ?? ""} disabled={session.readOnly} onChange={(e) => apply({ ...position, sceneId: e.target.value || undefined })}><option value="">Unassigned idea</option>{scenes.map((s) => <option key={s.sceneId} value={s.sceneId}>{s.number || ""} {s.heading}</option>)}</select></label>
    {position.sceneId && !linked && <p role="status">Linked scene is missing. Choose another scene explicitly.</p>}
    {!spatial && <div className="roadmap-grid">{(["x", "y"] as const).map((key) => <label key={key}>{key}<input type="number" aria-label={`${key} position of ${record.title || "Untitled"}`} value={display[key]} disabled={session.readOnly} onChange={(e) => setDraft({ ...display, [key]: Number(e.target.value) })}/></label>)}<button className="button" disabled={session.readOnly || !draft} onClick={() => draft && apply(draft)}>Apply position</button></div>}
    <div className="rewrite-actions"><button className="button" disabled={session.readOnly} onClick={() => app.openModal("rewrite.edit", { sessionId: session.id, record })}>Edit beat</button>{linked && <button className="button" onClick={() => { app.setView("script"); revealScene(linked.paragraphIds[0]!); }}>Go to linked scene</button>}</div>{error && <p role="alert">{error}</p>}
  </article>;
}
function CanvasView() {
    useDocVersion();
    const session = useSession(), { readOnly } = useSessionState(), [spatial, setSpatial] = useState(true), [zoom, setZoom] = useState(1), [filter, setFilter] = useState("");
    const all = records(session.doc, "beat").sort((a, b) => a.created.localeCompare(b.created)), items = all.filter((r) => `${r.title} ${r.text} ${placement(session.doc.meta.get(CANVAS_PREFIX + r.id)).lane}`.toLowerCase().includes(filter.toLowerCase()));
    return <section className="beat-canvas-view"><div className="beat-canvas-toolbar"><h2>Beat canvas</h2><button className="button primary" disabled={readOnly} onClick={() => void app.runCommand("rewrite.new.beat")}>New beat</button><button className="button" aria-pressed={!spatial} onClick={() => setSpatial(!spatial)}>{spatial ? "Accessible list" : "Spatial canvas"}</button><label>Zoom <select aria-label="Canvas zoom" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>{[0.5, 0.75, 1, 1.25].map((n) => <option key={n} value={n}>{Math.round(n * 100)}%</option>)}</select></label><input type="search" aria-label="Filter canvas" placeholder="Find a beat or storyline" value={filter} onChange={(e) => setFilter(e.target.value)}/></div>
    <p>Arrange ideas freely or link them to existing scenes. Moving a card never moves screenplay text. Arrow keys on a card’s Move button also work.</p>
    <div className={spatial ? "beat-canvas-scroll" : "beat-canvas-list"}><div style={spatial ? { width: 3100 * zoom, height: 2100 * zoom, position: "relative" } : undefined}><div style={spatial ? { width: 3100, height: 2100, transform: `scale(${zoom})`, transformOrigin: "top left" } : undefined}>{items.map((record) => <BeatCard key={session.id + record.id} record={record} index={all.indexOf(record)} spatial={spatial} zoom={zoom}/>)}</div></div></div>{!items.length && <p>No matching beats. New beat creates an idea, not a screenplay scene.</p>}
  </section>;
}
const feature: Feature = { id: "beat-canvas", views: [{ id: "beatCanvas", title: "Canvas", order: 45, component: CanvasView }], commands: [{ id: "canvas.open", label: "Beat Canvas", menu: "View", group: "planning", run: (a) => { a.setFocusMode(false); a.setView("beatCanvas"); } }] };
export default feature;
