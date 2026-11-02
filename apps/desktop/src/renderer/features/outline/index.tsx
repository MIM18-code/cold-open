// The outline: sections (acts, sequences) and scenes as a collapsible tree. Section titles and synopses edit in place,
// scenes and sections reorder by drag, and a section can be added at the top level or inside another section.
import { addSection, formatEighths, removeSection, sectionEndAnchor, type OutlineSection, type SceneSummary } from "@screenplay/engine";
import { useEffect, useMemo, useState } from "react";

import { app, type Feature } from "../../core/app.ts";
import { useSessionState } from "../../core/hooks.ts";
import { reorderClass, useReorderItem, useReorderMonitor } from "../navigator/reorder.ts";
import { ColorButton, EditableText, FdxNotice, ReadOnlyNotice, SynopsisField } from "../navigator/shared.tsx";
import {
  editSceneColor, editSectionTitle, editSynopsis, flattenOutline, moveByDrop, revealScene, useCaretScene, useStructure,
  type FlatItem,
} from "../navigator/structure-data.ts";
import "./outline.css";

function SceneRow({ scene, level, active, locked }: { scene: SceneSummary; level: number; active: boolean; locked: boolean }) {
  const { ref, edge, dragging } = useReorderItem<HTMLDivElement>("outline", { kind: "scene", id: scene.sceneId }, { drag: !locked });
  return (
    <div ref={ref} className={`outline-scene ${active ? "on" : ""} ${reorderClass({ edge, dragging })}`} data-scene-id={scene.sceneId}
      style={{ paddingLeft: 12 + level * 20 }}>
      <div className="outline-scene-line">
        <span className="structure-number">{scene.number ?? scene.index + 1}</span>
        <ColorButton color={scene.color} label={`Color of scene ${scene.number ?? scene.index + 1}`} onChange={(color) => editSceneColor(scene.sceneId, color)} />
        <button className="outline-heading" onClick={() => revealScene(scene.headingId)} title="Show in the script">{scene.heading || "Untitled scene"}</button>
        <span className="structure-length">{scene.eighths ? formatEighths(scene.eighths) : ""}</span>
      </div>
      <SynopsisField className="outline-synopsis" value={scene.synopsis} label={`Synopsis of scene ${scene.number ?? scene.index + 1}`}
        onCommit={(text) => editSynopsis({ kind: "scene", id: scene.sceneId }, text)} />
    </div>
  );
}

function SectionRow({ section, level, open, count, focusId, locked, onToggle, onAddChild, onRemove }: {
  section: OutlineSection; level: number; open: boolean; count: number; focusId: string | null; locked: boolean;
  onToggle(): void; onAddChild(): void; onRemove(): void;
}) {
  const { ref, edge, dragging } = useReorderItem<HTMLDivElement>("outline", { kind: "section", id: section.id }, { drag: !locked });
  return (
    <div ref={ref} className={`outline-section outline-section-${Math.min(section.depth, 3)} ${reorderClass({ edge, dragging })}`} data-section-id={section.id}
      style={{ paddingLeft: 4 + level * 20 }}>
      <div className="outline-section-line">
        <button className="icon-button outline-chevron" aria-label={open ? "Collapse section" : "Expand section"} aria-expanded={open} onClick={onToggle}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined }}>
            <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <EditableText className="outline-title" value={section.title} label="Section title" placeholder="Section title" autoFocus={focusId === section.id}
          onCommit={(title) => editSectionTitle(section.id, title)} />
        <span className="structure-length">{count} {count === 1 ? "scene" : "scenes"}</span>
        <button className="icon-button outline-action" title="Add a section inside this one" aria-label="Add subsection" disabled={locked} onClick={onAddChild}>+</button>
        <button className="icon-button outline-action" title="Remove this section title (its scenes stay)" aria-label="Remove section" disabled={locked} onClick={onRemove}>×</button>
      </div>
      <SynopsisField className="outline-synopsis" value={section.synopsis} label={`Synopsis of ${section.title || "section"}`}
        onCommit={(text) => editSynopsis({ kind: "section", id: section.id }, text)} />
    </div>
  );
}

/** An outline edit from a click. A read-only script refuses it; say so in a toast rather than throw out of the click. */
function tryEdit<T>(change: () => T): T | undefined {
  try {
    return app.session.edit(change);
  } catch (error) {
    app.toast(error instanceof Error ? error.message : String(error), "error");
    return undefined;
  }
}

function sceneCount(section: OutlineSection): number {
  return section.children.reduce((total, child) => total + (child.kind === "scene" ? 1 : sceneCount(child)), 0);
}

function Outline() {
  const structure = useStructure(150);
  const caret = useCaretScene(structure);
  const { readOnly } = useSessionState();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  useReorderMonitor("outline", moveByDrop);
  // The new section takes focus once; clear the request so a later remount does not grab focus again.
  useEffect(() => {
    if (!focusId) return;
    const timer = setTimeout(() => setFocusId(null), 1500);
    return () => clearTimeout(timer);
  }, [focusId]);

  const items = useMemo(() => flattenOutline(structure.outline), [structure]);
  // An item is hidden when any section above it is collapsed. Levels tell which sections are still open.
  const visible = useMemo(() => {
    const out: FlatItem[] = [];
    let hiddenBelow = Infinity;
    for (const item of items) {
      if (item.level > hiddenBelow) continue;
      hiddenBelow = Infinity;
      out.push(item);
      if (item.kind === "section" && collapsed.has(item.section.id)) hiddenBelow = item.level;
    }
    return out;
  }, [items, collapsed]);

  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const add = (parent: OutlineSection | null) => {
    const doc = app.session.doc;
    const script = app.session.script();
    const id = tryEdit(() => addSection(doc, parent
      ? { depth: parent.depth + 1, beforeId: sectionEndAnchor(script, parent.id) }
      : { depth: 1, beforeId: null }));
    if (id === undefined) return;
    setFocusId(id);
    if (parent) setCollapsed((current) => (current.has(parent.id) ? new Set([...current].filter((c) => c !== parent.id)) : current));
  };
  const sections = items.filter((item) => item.kind === "section").map((item) => item.kind === "section" ? item.section.id : "");

  return (
    <div className="outline">
      <div className="outline-toolbar">
        <button className="button" disabled={readOnly} onClick={() => add(null)}>Add section</button>
        <button className="button" disabled={!sections.length} onClick={() => setCollapsed(new Set(sections))}>Collapse all</button>
        <button className="button" disabled={!collapsed.size} onClick={() => setCollapsed(new Set())}>Expand all</button>
      </div>
      <ReadOnlyNotice />
      <FdxNotice />
      <div className="outline-scroll" role="group" aria-label="Outline">
        {visible.map((item) => {
          if (item.kind === "section") {
            const section = item.section;
            return (
              <SectionRow key={section.id} section={section} level={item.level} open={!collapsed.has(section.id)} count={sceneCount(section)}
                focusId={focusId} locked={readOnly} onToggle={() => toggle(section.id)} onAddChild={() => add(section)}
                onRemove={() => tryEdit(() => removeSection(app.session.doc, section.id))} />
            );
          }
          const scene = structure.scenes.get(item.sceneId);
          return scene ? <SceneRow key={scene.sceneId} scene={scene} level={item.level} active={scene.sceneId === caret} locked={readOnly} /> : null;
        })}
        {!items.length ? <div className="empty-note">No scenes yet. Add a section to start an outline, or write scene headings in the script.</div> : null}
      </div>
    </div>
  );
}

const feature: Feature = {
  id: "outline",
  views: [{ id: "outline", title: "Outline", order: 2, component: Outline }],
};

export default feature;
