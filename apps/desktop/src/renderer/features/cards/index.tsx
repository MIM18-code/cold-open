// Index cards: one card per scene in a grid, with the synopsis editable on the card, a color stripe, and drag and
// drop to reorder. Acts and sequences (sections) show as full-width dividers.
import { formatEighths, type OutlineSection, type SceneSummary } from "@screenplay/engine";
import { useMemo } from "react";

import type { Feature } from "../../core/app.ts";
import { useSessionState, useSetting } from "../../core/hooks.ts";
import { reorderClass, useReorderItem, useReorderMonitor } from "../navigator/reorder.ts";
import { ColorButton, EditableText, FdxNotice, ReadOnlyNotice, SynopsisField } from "../navigator/shared.tsx";
import {
  editSceneColor, editSectionTitle, editSynopsis, flattenOutline, moveByDrop, moveSceneByKey, revealScene, useCaretScene, useStructure,
} from "../navigator/structure-data.ts";
import "./cards.css";

const SIZES = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
] as const;
type CardSize = (typeof SIZES)[number]["id"];

function Card({ scene, active, locked }: { scene: SceneSummary; active: boolean; locked: boolean }) {
  const { ref, edge, dragging } = useReorderItem<HTMLElement>("cards", { kind: "scene", id: scene.sceneId }, { axis: "x", drag: !locked });
  return (
    <article ref={ref} className={`cards-card ${active ? "on" : ""} ${reorderClass({ edge, dragging }, "x")}`} data-scene-id={scene.sceneId}
      aria-label={scene.heading || "Untitled scene"} tabIndex={0} aria-keyshortcuts={locked ? undefined : "Alt+ArrowLeft Alt+ArrowRight"}
      onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); revealScene(scene.headingId); } }}
      onDoubleClick={(event) => {
        if (!(event.target as HTMLElement).closest("textarea, input, button")) revealScene(scene.headingId);
      }}>
      <div className="cards-stripe" style={scene.color ? { background: scene.color } : undefined} />
      <header className="cards-head">
        <span className="structure-number">{scene.number ?? scene.index + 1}</span>
        <h3 title={scene.heading}>{scene.heading || "Untitled scene"}</h3>
        <ColorButton color={scene.color} label={`Color of scene ${scene.number ?? scene.index + 1}`}
          onChange={(color) => editSceneColor(scene.sceneId, color)} />
      </header>
      <SynopsisField className="cards-synopsis" value={scene.synopsis} label={`Synopsis of scene ${scene.number ?? scene.index + 1}`}
        onCommit={(text) => editSynopsis({ kind: "scene", id: scene.sceneId }, text)} />
      <footer className="cards-foot">
        <span className="cards-characters" title={scene.characters.join(", ")}>{scene.characters.slice(0, 3).join(", ")}</span>
        <span className="structure-length">{scene.eighths ? formatEighths(scene.eighths) : ""}{scene.page ? ` · p. ${scene.page}` : ""}</span>
      </footer>
    </article>
  );
}

function Divider({ section }: { section: OutlineSection }) {
  const { ref, edge } = useReorderItem<HTMLDivElement>("cards", { kind: "section", id: section.id }, { drag: false, axis: "y" });
  return (
    <div ref={ref} className={`cards-divider cards-divider-${Math.min(section.depth, 3)} ${reorderClass({ edge, dragging: false })}`}>
      <EditableText className="cards-divider-title" value={section.title} label="Section title" placeholder="Section title"
        onCommit={(title) => editSectionTitle(section.id, title)} />
    </div>
  );
}

function Cards() {
  const structure = useStructure(150);
  const [size, setSize] = useSetting<CardSize>("cards.size", "medium");
  const caret = useCaretScene(structure);
  const { readOnly } = useSessionState();
  useReorderMonitor("cards", moveByDrop);
  const items = useMemo(() => flattenOutline(structure.outline), [structure]);
  const count = structure.summaries.length;
  return (
    <div className="cards" data-size={size}>
      <div className="cards-toolbar">
        <span className="cards-count">{count} {count === 1 ? "card" : "cards"}</span>
        <div className="segmented" role="group" aria-label="Card size">
          {SIZES.map((s) => (
            <button key={s.id} className={s.id === size ? "on" : ""} aria-pressed={s.id === size} onClick={() => setSize(s.id)}>{s.label}</button>
          ))}
        </div>
      </div>
      <ReadOnlyNotice />
      <FdxNotice />
      <div className="cards-scroll" onKeyDown={(event) => moveSceneByKey(event, readOnly)}>
        {count || items.length ? (
          <div className="cards-grid">
            {items.map((item) => {
              if (item.kind === "section") return <Divider key={item.section.id} section={item.section} />;
              const scene = structure.scenes.get(item.sceneId);
              return scene ? <Card key={scene.sceneId} scene={scene} active={scene.sceneId === caret} locked={readOnly} /> : null;
            })}
          </div>
        ) : (
          <div className="empty-note">No scenes yet. Each scene heading in the script becomes a card.</div>
        )}
      </div>
    </div>
  );
}

const feature: Feature = {
  id: "cards",
  views: [{ id: "cards", title: "Cards", order: 1, component: Cards }],
};

export default feature;
