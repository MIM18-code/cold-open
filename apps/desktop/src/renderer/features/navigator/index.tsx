// The Scenes panel on the left: every scene with its number, heading, synopsis and length. Click to jump to it in
// the script, drag to reorder, filter by text. Also the Go to Scene command and the Number Scenes commands.
import { formatEighths, numberScenes, removeSceneNumbers, type SceneSummary } from "@screenplay/engine";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { useSessionState } from "../../core/hooks.ts";
import { reorderClass, useReorderItem, useReorderMonitor } from "./reorder.ts";
import {
  flattenOutline, moveByDrop, moveSceneBy, revealScene, useCaretScene, useStructure, type FlatItem, type Structure,
} from "./structure-data.ts";
import "./navigator.css";

function matches(scene: SceneSummary, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${scene.number ?? ""} ${scene.heading} ${scene.synopsis} ${scene.characters.join(" ")}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

const SceneRow = memo(function SceneRow({ scene, active, draggable, tabStop }: { scene: SceneSummary; active: boolean; draggable: boolean; tabStop: boolean }) {
  const { ref, edge, dragging } = useReorderItem<HTMLDivElement>("navigator", { kind: "scene", id: scene.sceneId }, { drag: draggable });
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active, ref]);
  return (
    <div ref={ref} role="option" aria-selected={active} tabIndex={tabStop ? 0 : -1} data-scene-id={scene.sceneId}
      className={`navigator-row ${active ? "on" : ""} ${reorderClass({ edge, dragging })}`}
      onClick={(event) => { event.currentTarget.focus(); revealScene(scene.headingId); }}>
      <span className="navigator-stripe" style={scene.color ? { background: scene.color } : undefined} />
      <span className="structure-number">{scene.number ?? scene.index + 1}</span>
      <span className="navigator-text">
        <span className="navigator-heading">{scene.heading || "Untitled scene"}</span>
        {scene.synopsis ? <span className="navigator-synopsis">{scene.synopsis}</span> : null}
      </span>
      <span className="structure-length">{scene.eighths ? formatEighths(scene.eighths) : ""}</span>
    </div>
  );
}, (a, b) => a.active === b.active && a.draggable === b.draggable && a.tabStop === b.tabStop && a.scene.sceneId === b.scene.sceneId && a.scene.headingId === b.scene.headingId && a.scene.index === b.scene.index && a.scene.number === b.scene.number && a.scene.heading === b.scene.heading && a.scene.synopsis === b.scene.synopsis && a.scene.color === b.scene.color && a.scene.eighths === b.scene.eighths);

function SectionLabel({ id, title, level }: { id: string; title: string; level: number }) {
  const { ref, edge } = useReorderItem<HTMLDivElement>("navigator", { kind: "section", id }, { drag: false });
  return (
    <div ref={ref} className={`navigator-section ${reorderClass({ edge, dragging: false })}`} style={{ paddingLeft: 12 + level * 10 }}>
      {title || "Untitled section"}
    </div>
  );
}

function Navigator() {
  const structure = useStructure();
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const caret = useCaretScene(structure);
  const { readOnly } = useSessionState();
  const filtering = query.trim() !== "";
  useReorderMonitor("navigator", moveByDrop);

  const rows = useMemo(() => {
    if (filtering) return structure.summaries.filter((scene) => matches(scene, query)).map((scene): FlatItem => ({ kind: "scene", sceneId: scene.sceneId, level: 0 }));
    return flattenOutline(structure.outline);
  }, [structure, query, filtering]);
  const visible = rows.filter((r): r is Extract<FlatItem, { kind: "scene" }> => r.kind === "scene").map((r) => r.sceneId);
  const tabStop = (focusedId && visible.includes(focusedId) ? focusedId : caret && visible.includes(caret) ? caret : visible[0]) ?? null;
  const move = (sceneId: string | null, direction: -1 | 1) => {
    if (filtering || readOnly || !sceneId) return;
    if (moveSceneBy(sceneId, direction)) setFocusedId(sceneId);
  };
  const focusedIndex = structure.summaries.findIndex((s) => s.sceneId === tabStop);

  return (
    <div className="navigator">
      <div className="navigator-filter">
        <input type="search" value={query} placeholder="Filter scenes" aria-label="Filter scenes"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") setQuery("");
          }} />
      </div>
      <div className="navigator-list" role="listbox" aria-label="Scenes"
        onFocusCapture={(event) => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-scene-id]"); if (row?.dataset.sceneId) setFocusedId(row.dataset.sceneId); }}
        onKeyDown={(event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>("[data-scene-id]");
          if (!row) return;
          const id = row.dataset.sceneId ?? "";
          if ((event.altKey || event.metaKey) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            move(id, event.key === "ArrowUp" ? -1 : 1);
            return;
          }
          if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const at = visible.indexOf(id);
            const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1
              : Math.max(0, Math.min(visible.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
            const nextId = visible[next];
            if (nextId) {
              setFocusedId(nextId);
              const dest = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-scene-id]")).find((x) => x.dataset.sceneId === nextId);
              dest?.focus();
            }
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const scene = structure.scenes.get(id);
            if (scene) revealScene(scene.headingId);
          }
        }}>
        {rows.map((item) => {
          if (item.kind === "section") {
            return <SectionLabel key={item.section.id} id={item.section.id} title={item.section.title} level={item.level} />;
          }
          const scene = structure.scenes.get(item.sceneId);
          return scene ? <SceneRow key={scene.sceneId} scene={scene} active={scene.sceneId === caret} draggable={!filtering && !readOnly} tabStop={scene.sceneId === tabStop} /> : null;
        })}
        {!rows.length ? (
          <div className="empty-note">{filtering ? "No scene matches." : "No scenes yet. A scene starts with a scene heading."}</div>
        ) : null}
      </div>
      <div className="navigator-foot navigator-foot-actions">
        <span>{summary(structure)}</span>
        <span className="navigator-move-actions">
          <button type="button" title="Move focused scene earlier (Option+↑)" aria-label="Move focused scene earlier" disabled={filtering || readOnly || focusedIndex <= 0}
            onClick={() => move(tabStop, -1)}>↑</button>
          <button type="button" title="Move focused scene later (Option+↓)" aria-label="Move focused scene later" disabled={filtering || readOnly || focusedIndex < 0 || focusedIndex >= structure.summaries.length - 1}
            onClick={() => move(tabStop, 1)}>↓</button>
        </span>
      </div>
    </div>
  );
}

function summary(structure: Structure): string {
  const count = structure.summaries.length;
  const eighths = structure.summaries.reduce((total, scene) => total + scene.eighths, 0);
  return `${count} ${count === 1 ? "scene" : "scenes"}${eighths ? `, ${formatEighths(eighths)} pages` : ""}`;
}

function GoToScene({ close }: ModalProps) {
  const structure = useStructure(0);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const found = useMemo(() => {
    const q = query.trim();
    if (!q) return structure.summaries;
    const exact = structure.summaries.filter((scene) => scene.number === q);
    return [...exact, ...structure.summaries.filter((scene) => !exact.includes(scene) && matches(scene, q))];
  }, [structure, query]);
  useEffect(() => {
    list.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const choose = (scene: SceneSummary | undefined) => {
    if (!scene) return;
    close();
    revealScene(scene.headingId);
  };
  return (
    <div className="navigator-goto">
      <input autoFocus value={query} placeholder="Scene number or words from the heading" aria-label="Scene" role="combobox" aria-expanded="true"
        aria-controls="goto-scenes" aria-activedescendant={found.length ? `goto-scene-${index}` : undefined} autoComplete="off"
        onChange={(event) => (setQuery(event.target.value), setIndex(0))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") (event.preventDefault(), setIndex((i) => Math.min(i + 1, found.length - 1)));
          else if (event.key === "ArrowUp") (event.preventDefault(), setIndex((i) => Math.max(i - 1, 0)));
          else if (event.key === "Enter") choose(found[index]);
        }} />
      <ul ref={list} id="goto-scenes" role="listbox" aria-label="Scenes">
        {found.map((scene, i) => (
          <li key={scene.sceneId} id={`goto-scene-${i}`} role="option" aria-selected={i === index} className={i === index ? "on" : ""} onMouseEnter={() => setIndex(i)} onClick={() => choose(scene)}>
            <span className="structure-number">{scene.number ?? scene.index + 1}</span>
            <span className="navigator-goto-heading" title={scene.heading || undefined}>{scene.heading || "Untitled scene"}</span>
            <span className="structure-length">{scene.eighths ? formatEighths(scene.eighths) : ""}</span>
          </li>
        ))}
        {!found.length ? <li className="navigator-goto-none" role="presentation">No matching scene</li> : null}
      </ul>
    </div>
  );
}

function hasScenes(a: typeof app): boolean {
  return a.session.script().paragraphs.some((paragraph) => paragraph.type === "sceneHeading");
}

function canNumber(a: typeof app): boolean {
  return !a.session.readOnly && hasScenes(a);
}

function report(count: number, done: string, none: string): void {
  app.toast(count ? `${done} (${count})` : none, count ? "success" : "info");
}

const feature: Feature = {
  id: "navigator",
  panels: [{ id: "navigator", title: "Scenes", side: "left", order: 0, component: Navigator }],
  modals: [{ id: "structure.goToScene", title: "Go to Scene", width: 560, component: GoToScene }],
  commands: [
    { id: "structure.goToScene", label: "Go to Scene…", menu: "Script", group: "navigate", accelerator: "CmdOrCtrl+Shift+J",
      enabled: hasScenes, run: (a) => a.openModal("structure.goToScene") },
    { id: "structure.numberScenes", label: "Number Scenes", menu: "Script", group: "numbering", enabled: canNumber,
      run: (a) => report(a.session.edit(() => numberScenes(a.session.doc)), "Numbered the scenes", "Scenes are already numbered.") },
    { id: "structure.removeSceneNumbers", label: "Remove Scene Numbers", menu: "Script", group: "numbering", enabled: canNumber,
      run: (a) => report(a.session.edit(() => removeSceneNumbers(a.session.doc)), "Removed scene numbers", "No scene has a number.") },
  ],
};

export default feature;
