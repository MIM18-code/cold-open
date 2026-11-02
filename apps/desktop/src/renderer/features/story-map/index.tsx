// The story map: the whole script as a horizontal page timeline. Scene blocks are as long as their scenes, in the
// scene's color (or the revision color of its text). Structure points are named target positions the writer
// drags along the top; a point pinned to a scene shows how many pages the scene sits from the target.
import {
  addStructurePoint, addStructurePointPreset, clampPosition, formatPointPage, pageDelta, parsePointPosition,
  pointPage, removeStructurePoint, revisionState, storyMap, structurePoints, updateStructurePoint,
  type StoryMap, type StoryMapScene, type StructurePoint,
} from "@screenplay/engine";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { app, type App, type Feature } from "../../core/app.ts";
import type { EditorBridge } from "../../core/editor-bridge.ts";
import { useDocVersion, useSession, useSessionState } from "../../core/hooks.ts";
import type { DocumentSession } from "../../core/session.ts";
import { EditableText, ReadOnlyNotice } from "../navigator/shared.tsx";
import { revealScene, useCaretScene, useStructure } from "../navigator/structure-data.ts";
import "./story-map.css";

/** The scene the writer was in when they left the script view, kept so the map has a playhead. */
let lastCaret: { session: DocumentSession; paragraphId: string } | null = null;

function watchCaret(app: App): () => void {
  let editor: EditorBridge | null = null;
  let offSelection: (() => void) | undefined;
  const track = () => {
    if (app.editor === editor) return;
    offSelection?.();
    editor = app.editor;
    offSelection = undefined;
    if (!editor) return;
    const note = () => {
      const paragraphId = editor?.currentParagraphId();
      if (paragraphId) lastCaret = { session: app.session, paragraphId };
    };
    note();
    offSelection = editor.onSelectionChange(note);
  };
  track();
  const offApp = app.subscribe(track);
  const offSession = app.onSession(() => { lastCaret = null; });
  return () => {
    offApp();
    offSession();
    offSelection?.();
  };
}

const ZOOM_LEVELS = [6, 10, 16, 24, 36, 56, 84, 120, 168];

function edit<T>(change: () => T): T | undefined {
  try {
    return app.session.edit(change);
  } catch (error) {
    app.toast(error instanceof Error ? error.message : String(error), "error");
    return undefined;
  }
}

function pageText(page: number | string): string {
  return formatPointPage(page);
}

function deltaText(delta: number | undefined): string {
  if (delta === undefined) return "";
  if (Math.abs(delta) < 0.25) return "On target";
  const amount = Math.round(Math.abs(delta) * 10) / 10;
  return `${amount} ${amount === 1 ? "page" : "pages"} ${delta > 0 ? "late" : "early"}`;
}

let probe: HTMLSpanElement | undefined;
/** A label's rendered width, measured off screen with the label's own styles; estimated where there is no DOM. */
function labelWidth(name: string, delta: string): number {
  const estimate = 34 + (name.length + delta.length) * 7;
  if (typeof document === "undefined") return estimate;
  if (!probe) {
    probe = document.createElement("span");
    probe.className = "story-map-probe";
    probe.setAttribute("aria-hidden", "true");
    document.body.appendChild(probe);
  }
  probe.replaceChildren(Object.assign(document.createElement("span"), { className: "story-map-marker-name", textContent: name }),
    ...(delta ? [Object.assign(document.createElement("span"), { className: "story-map-marker-delta", textContent: delta })] : []));
  const width = Math.ceil(probe.getBoundingClientRect().width);
  probe.replaceChildren();
  return width || estimate;
}

function shortDelta(delta: number | undefined): string {
  if (delta === undefined) return "";
  if (Math.abs(delta) < 0.25) return "on target";
  const amount = Math.round(Math.abs(delta) * 10) / 10;
  return `${delta > 0 ? "+" : "−"}${amount.toFixed(1)}`;
}

function revisionTint(scene: StoryMapScene): string | undefined {
  const color = scene.revision?.color;
  // White is the original draft, not a revision, and would make a white block on the paper.
  return color && color.toUpperCase() !== "#FFFFFF" ? color : undefined;
}

/** The scene blocks and the playhead. Memoized so dragging a structure point does not redraw a long script. */
const SceneTrack = memo(function SceneTrack({ map, pixelsPerPage, playScene }: {
  map: StoryMap;
  pixelsPerPage: number;
  playScene: StoryMapScene | undefined;
}) {
  return (
    <>
      {map.scenes.map((scene, index) => {
        const width = Math.max(1, scene.length * pixelsPerPage);
        const tint = scene.color ?? revisionTint(scene);
        const band = scene.color ? revisionTint(scene) : undefined;
        const variables = tint ? ({ "--block-color": tint } as CSSProperties) : {};
        const current = playScene?.sceneId === scene.sceneId;
        return (
          <button key={scene.sceneId} type="button" data-scene-id={scene.sceneId}
            className={`story-map-block ${current ? "on" : ""} ${tint ? "" : "plain"}`}
            style={{ left: `${scene.start * pixelsPerPage}px`, width: `${width}px`, ...variables,
              ...(band ? ({ "--block-band": band } as CSSProperties) : {}) }}
            title={`${scene.number ?? index + 1}. ${scene.heading || "Untitled scene"} · ${pageText(scene.page)}`}
            // A block with its heading showing is named by that text; a narrow one needs a label.
            {...(width >= 72 ? {} : { "aria-label": `Scene ${scene.number ?? index + 1}, ${scene.heading || "Untitled scene"}, page ${scene.page}` })}
            onClick={() => revealScene(scene.headingId)}>
            {width >= 72 ? (
              <span className="story-map-block-label">
                <strong>{scene.number ?? index + 1}</strong>
                <span>{scene.heading || "Untitled scene"}</span>
                <span className="visually-hidden">, page {scene.page}</span>
              </span>
            ) : width >= 16 ? <span className="story-map-block-number">{scene.number ?? index + 1}</span> : null}
          </button>
        );
      })}
      {!map.scenes.length ? <p className="story-map-empty">No scenes yet. Scene headings become blocks on the map.</p> : null}
      {playScene ? (
        <span className="story-map-playhead" style={{ left: `${playScene.start * pixelsPerPage}px` }}
          title={`Current scene: ${playScene.heading || "Untitled scene"}`} aria-hidden="true" />
      ) : null}
    </>
  );
});

/**
 * A target field that accepts a page ("p. 61", "61") or a share of the script ("50%"). It holds the draft until
 * focus leaves, and registers with app.onFlush so Save writes a target still being typed.
 */
function TargetField({ point, pages, pageLabels, onCommit, disabled }: {
  point: StructurePoint;
  pages: number;
  pageLabels: readonly string[];
  onCommit(position: number): void;
  disabled: boolean;
}) {
  const session = useSession();
  const shown = pageText(pointPage(point.position, pages, pageLabels));
  const [draft, setDraft] = useState(shown);
  const state = useRef({ session, focused: false, dirty: false, draft: shown, base: shown, pages, pageLabels, commit: onCommit });
  state.current.pages = pages;
  state.current.pageLabels = pageLabels;
  state.current.commit = onCommit;
  if (state.current.session !== session) {
    state.current = { session, focused: false, dirty: false, draft: shown, base: shown, pages, pageLabels, commit: onCommit };
    if (draft !== shown) setDraft(shown);
  }
  useEffect(() => {
    const s = state.current;
    s.base = shown;
    if (!s.focused) {
      s.draft = shown;
      s.dirty = false;
      setDraft(shown);
    }
  }, [shown]);
  const write = useCallback(() => {
    const s = state.current;
    if (app.session !== s.session) {
      s.dirty = false;
      return;
    }
    if (!s.dirty) return;
    s.dirty = false;
    if (app.session.readOnly) {
      s.draft = s.base;
      setDraft(s.base);
      return;
    }
    if (s.draft === s.base) return;
    const position = parsePointPosition(s.draft, s.pages, s.pageLabels);
    if (position === undefined) {
      app.toast("Enter a page number, or a share of the script like 25%.", "error");
      s.draft = s.base;
      setDraft(s.base);
      return;
    }
    s.base = s.draft;
    s.commit(position);
  }, []);
  useEffect(() => {
    const off = app.onFlush(write);
    return () => {
      off();
      write();
    };
  }, [write]);
  return (
    <label className="story-map-target">
      <span>Target</span>
      <input value={draft} aria-label={`Target page for ${point.name}`} disabled={disabled} spellCheck={false}
        onChange={(event) => {
          state.current.draft = event.target.value;
          state.current.dirty = true;
          setDraft(event.target.value);
        }}
        onFocus={() => { state.current.focused = true; }}
        onBlur={() => {
          state.current.focused = false;
          write();
          if (state.current.draft !== state.current.base) setDraft(state.current.base);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") event.currentTarget.blur();
          else if (event.key === "Escape") {
            state.current.dirty = false;
            state.current.draft = state.current.base;
            setDraft(state.current.base);
            event.currentTarget.blur();
          }
        }} />
    </label>
  );
}

function PointRow({ point, map, selected, readOnly, focus, onSelect, onRemoved }: {
  point: StructurePoint;
  map: StoryMap;
  selected: boolean;
  readOnly: boolean;
  focus: boolean;
  onSelect(): void;
  onRemoved(): void;
}) {
  const scene = point.sceneId ? map.scenes.find((candidate) => candidate.sceneId === point.sceneId) : undefined;
  const missing = point.sceneId !== undefined && !scene;
  const delta = scene ? pageDelta(point.position, scene.start, map.pages) : undefined;
  const change = (patch: { name?: string; position?: number; sceneId?: string | null }) =>
    edit(() => updateStructurePoint(app.session.doc, point.id, patch));
  const scenes = map.scenes;
  return (
    <div className={`story-map-point ${selected ? "on" : ""}`} data-point-id={point.id}
      onPointerDown={onSelect} onFocusCapture={onSelect}>
      <div className="story-map-point-head">
        <EditableText className="story-map-point-name" value={point.name} label={`Name of ${point.name}`} placeholder="Point name"
          autoFocus={focus} onCommit={(name) => change({ name })} />
        <button className="icon-button story-map-remove" type="button" aria-label={`Remove ${point.name}`} title="Remove this point"
          disabled={readOnly} onClick={() => {
            if (edit(() => removeStructurePoint(app.session.doc, point.id))) onRemoved();
          }}>×</button>
      </div>
      <div className="story-map-point-targetline">
        <TargetField point={point} pages={map.pages} pageLabels={map.pageLabels} disabled={readOnly} onCommit={(position) => change({ position })} />
        <span className="story-map-share" title="Share of the script">{Math.round(point.position * 100)}%</span>
      </div>
      <select className="story-map-scene" aria-label={`Scene for ${point.name}`} value={point.sceneId ?? ""} disabled={readOnly}
        onChange={(event) => change({ sceneId: event.target.value || null })}>
        <option value="">Not pinned to a scene</option>
        {missing ? <option value={point.sceneId} disabled>The pinned scene is gone</option> : null}
        {scenes.map((candidate, index) => (
          <option key={candidate.sceneId} value={candidate.sceneId}>
            {candidate.number ?? index + 1}. {candidate.heading || "Untitled scene"}
          </option>
        ))}
      </select>
      {scene || missing ? (
        <p className="story-map-actual">
          {scene ? `Scene starts ${pageText(scene.page)} · ${deltaText(delta)}` : "The scene this point was pinned to is gone."}
        </p>
      ) : null}
    </div>
  );
}

function StoryMapView() {
  const structure = useStructure(120);
  const session = useSession();
  const version = useDocVersion();
  const { readOnly } = useSessionState();
  const caretScene = useCaretScene(structure);
  const revisions = useMemo(() => revisionState(session.doc), [session, version]);
  const map = useMemo(() => storyMap(structure.script, structure.pagination, revisions, structure.summaries),
    [structure, revisions]);
  const points = useMemo(() => structurePoints(session.doc), [session, version]);

  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  const [fitWidth, setFitWidth] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; position: number } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<{ id: string; x: number; start: number; position: number; moved: boolean; pointerId: number } | null>(null);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const measure = () => setFitWidth(Math.max(0, element.clientWidth - 24));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setSelectedId(null);
    setFocusId(null);
    setPreview(null);
    drag.current = null;
  }, [session]);

  useEffect(() => {
    if (!focusId) return;
    const timer = setTimeout(() => setFocusId(null), 1500);
    return () => clearTimeout(timer);
  }, [focusId]);

  const pixelsPerPage = useMemo(() => {
    if (zoomMode === "fit") return fitWidth > 0 && map.pages > 0 ? fitWidth / map.pages : 16;
    return zoomMode;
  }, [zoomMode, fitWidth, map.pages]);
  const trackWidth = Math.max(1, map.pages * pixelsPerPage);

  // The editor unmounts in this view, so fall back to the scene the writer was last in.
  const lastParagraph = lastCaret?.session === session ? lastCaret.paragraphId : null;
  const playScene = useMemo(() => {
    const id = caretScene ?? (lastParagraph ? structure.sceneOfParagraph(lastParagraph) : undefined);
    return id ? map.scenes.find((scene) => scene.sceneId === id) : undefined;
  }, [caretScene, lastParagraph, structure, map]);

  useEffect(() => {
    const element = scroll.current;
    if (!element || !playScene) return;
    const x = playScene.start * pixelsPerPage;
    if (x < element.scrollLeft + 24 || x > element.scrollLeft + element.clientWidth - 48) {
      element.scrollLeft = Math.max(0, x - element.clientWidth / 3);
    }
  }, [playScene, pixelsPerPage]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    rows.current.get(id)?.scrollIntoView({ block: "nearest" });
  }, []);

  const commitPosition = useCallback((id: string, position: number) => {
    if (app.session.readOnly) return;
    app.session.undo.stopCapturing();
    edit(() => updateStructurePoint(app.session.doc, id, { position }));
    app.session.undo.stopCapturing();
  }, []);

  const add = () => {
    const at = playScene && map.pages > 0 ? clampPosition(playScene.start / map.pages) : 0.5;
    const point = edit(() => addStructurePoint(app.session.doc, { position: at }));
    if (!point) return;
    setSelectedId(point.id);
    setFocusId(point.id);
    requestAnimationFrame(() => rows.current.get(point.id)?.scrollIntoView({ block: "nearest" }));
  };

  const applyPreset = (id: string) => {
    const added = edit(() => addStructurePointPreset(app.session.doc, id));
    if (!added) return;
    if (added.length) app.toast(`Added ${added.length} ${added.length === 1 ? "point" : "points"}.`, "success");
    else app.toast("Those points are already in the list.");
  };

  const zoomIn = () => {
    const next = ZOOM_LEVELS.find((level) => level > pixelsPerPage + 0.01);
    setZoomMode(next ?? ZOOM_LEVELS.at(-1)!);
  };
  const zoomOut = () => {
    const next = [...ZOOM_LEVELS].reverse().find((level) => level < pixelsPerPage - 0.01);
    setZoomMode(next ?? ZOOM_LEVELS[0]!);
  };

  // Ruler ticks: page 1, then every 1, 2, 5, 10 or more pages, far enough apart to hold a number.
  const tickStep = [1, 2, 5, 10, 20, 25, 50, 100].find((step) => step * pixelsPerPage >= 46) ?? 100;
  const ticks = useMemo(
    () => Array.from({ length: map.pages > 0 ? Math.floor((map.pages - 1) / tickStep) + 1 : 0 }, (_, index) => index * tickStep),
    [map.pages, tickStep],
  );

  // Each label takes the first row where it overlaps nothing, measured at its real width; a label that would run
  // past the end of the timeline ends at its marker instead.
  const markers = useMemo(() => {
    const rows: [number, number][][] = [];
    return points.map((point) => {
      const position = preview?.id === point.id ? preview.position : point.position;
      const x = clampPosition(position) * trackWidth;
      const scene = point.sceneId ? map.scenes.find((candidate) => candidate.sceneId === point.sceneId) : undefined;
      const delta = scene ? pageDelta(position, scene.start, map.pages) : undefined;
      const width = labelWidth(point.name, scene ? shortDelta(delta) : "");
      const flip = x + width > trackWidth && x - width >= 0;
      const from = flip ? x - width : x, to = flip ? x : x + width;
      let row = rows.findIndex((taken) => taken.every(([a, b]) => to + 8 <= a || from >= b + 8));
      if (row < 0) { row = rows.length; rows.push([]); }
      rows[row]!.push([from, to]);
      return { point, position, x, scene, delta, row, flip };
    });
  }, [points, preview, map, trackWidth]);
  const laneHeight = Math.max(1, Math.max(0, ...markers.map((marker) => marker.row)) + 1) * 22 + 16;

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>, point: StructurePoint) => {
    select(point.id);
    if (readOnly || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: point.id, x: event.clientX, start: point.position, position: point.position, moved: false, pointerId: event.pointerId };
  };
  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) < 3) return;
    state.moved = true;
    const position = clampPosition(state.start + (map.pages > 0 ? dx / pixelsPerPage / map.pages : 0));
    state.position = position;
    setPreview({ id: state.id, position });
  };
  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    if (event.currentTarget.hasPointerCapture(state.pointerId)) event.currentTarget.releasePointerCapture(state.pointerId);
    if (state.moved) commitPosition(state.id, state.position);
    setPreview(null);
  };

  const sceneCount = map.scenes.length;
  const pagesWide = pixelsPerPage > 0 ? Math.max(1, Math.round(fitWidth / pixelsPerPage)) : 0;

  return (
    <div className="story-map" data-pages={map.pages}>
      <div className="story-map-toolbar">
        <span className="story-map-count">
          {sceneCount} {sceneCount === 1 ? "scene" : "scenes"} · {map.pages} {map.pages === 1 ? "page" : "pages"}
        </span>
        <div className="story-map-zoom" role="group" aria-label="Timeline zoom">
          <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out" onClick={zoomOut}>−</button>
          <button type="button" className={`icon-button ${zoomMode === "fit" ? "on" : ""}`} aria-pressed={zoomMode === "fit"}
            title="Fit the whole script in the window" onClick={() => setZoomMode("fit")}>Fit</button>
          <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in" onClick={zoomIn}>+</button>
          <span className="story-map-zoom-readout">{zoomMode === "fit" ? "Whole script" : `${pagesWide} pages wide`}</span>
        </div>
      </div>
      <ReadOnlyNotice />
      <PointsNotice />
      <div className="story-map-body">
        <div className="story-map-scroll" ref={scroll}>
          <div className="story-map-canvas" style={{ width: `${trackWidth + 160}px` }}>
            <div className="story-map-ruler" style={{ width: `${trackWidth}px` }} aria-hidden="true">
              {ticks.map((index) => (
                <span key={index} className="story-map-tick" style={{ left: `${index * pixelsPerPage}px` }}>
                  <span>{map.pageLabels[index]}</span>
                </span>
              ))}
            </div>
            <div className="story-map-points-lane" style={{ width: `${trackWidth}px`, height: `${laneHeight}px` }} aria-label="Structure points"
              role="group">
              {markers.map((marker) => {
                const { point, scene, delta, row } = marker;
                const selected = selectedId === point.id;
                return (
                  <div key={point.id} className={`story-map-marker ${selected ? "on" : ""}`} style={{ left: `${marker.x}px` }} data-point-id={point.id}>
                    <button type="button" className="story-map-marker-label" style={{ top: `${row * 22 + 4}px`, ...(marker.flip ? { left: "auto", right: 0 } : {}) }}
                      aria-disabled={readOnly} aria-label={`${point.name}, target ${pageText(pointPage(marker.position, map.pages, map.pageLabels))}${
                        scene ? `, scene at ${pageText(scene.page)}, ${deltaText(delta)}` : ""}. Drag or use arrow keys to move it.`}
                      onPointerDown={(event) => startDrag(event, point)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={() => { drag.current = null; setPreview(null); }}
                      onFocus={() => select(point.id)}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (readOnly) return;
                        const step = (event.shiftKey ? 5 : 1) / Math.max(1, map.pages);
                        commitPosition(point.id, clampPosition(point.position + (event.key === "ArrowRight" ? step : -step)));
                      }}>
                      <span className="story-map-marker-name">{point.name}</span>
                      {scene ? <span className="story-map-marker-delta">{shortDelta(delta)}</span> : null}
                    </button>
                    <span className="story-map-stem" style={{ top: `${row * 22 + 24}px` }} aria-hidden="true" />
                    <span className="story-map-pin" aria-hidden="true" />
                    {scene ? (
                      <>
                        <span className="story-map-connector" aria-hidden="true"
                          style={{ left: `${Math.min(0, scene.start * pixelsPerPage - marker.x)}px`,
                            width: `${Math.abs(scene.start * pixelsPerPage - marker.x)}px` }} />
                        <span className="story-map-actual-dot" aria-hidden="true"
                          style={{ left: `${scene.start * pixelsPerPage - marker.x}px` }} />
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="story-map-track" style={{ width: `${trackWidth}px` }}>
              <div className="story-map-grid" aria-hidden="true">
                {ticks.map((index) => <span key={index} style={{ left: `${index * pixelsPerPage}px` }} />)}
              </div>
              <SceneTrack map={map} pixelsPerPage={pixelsPerPage} playScene={playScene} />
            </div>
          </div>
        </div>
        <aside className="story-map-points" aria-label="Structure points">
          <header className="story-map-points-head">
            <h2>Structure points</h2>
            <span>{points.length || ""}</span>
          </header>
          <div className="story-map-points-list">
            {points.map((point) => (
              <div key={point.id} ref={(element) => {
                if (element) rows.current.set(point.id, element);
                else rows.current.delete(point.id);
              }}>
                <PointRow point={point} map={map} selected={selectedId === point.id} readOnly={readOnly} focus={focusId === point.id}
                  onSelect={() => select(point.id)} onRemoved={() => setFocusId(null)} />
              </div>
            ))}
            {!points.length ? (
              <p className="story-map-points-empty">No structure points. Add one where a beat should land, or start from a preset.</p>
            ) : null}
          </div>
          <footer className="story-map-points-foot">
            <button type="button" className="button" disabled={readOnly} onClick={add}>Add point</button>
            <select aria-label="Add a preset" value="" disabled={readOnly}
              onChange={(event) => {
                const preset = event.target.value;
                event.currentTarget.value = "";
                if (preset) applyPreset(preset);
              }}>
              <option value="">Preset…</option>
              <option value="threeAct">Three-act</option>
              <option value="beatSheet">Beat sheet</option>
            </select>
          </footer>
        </aside>
      </div>
    </div>
  );
}

function PointsNotice() {
  const { format } = useSessionState();
  if (format === "screenplay") return null;
  return (
    <p className="structure-notice">
      {format === "fdx" ? "Final Draft files" : "Fountain files"} don't keep structure points. Use Save As to keep
      them in a .screenplay file.
    </p>
  );
}

const feature: Feature = {
  id: "story-map",
  views: [{ id: "storyMap", title: "Story Map", order: 3, component: StoryMapView }],
  activate: watchCaret,
};

export default feature;
