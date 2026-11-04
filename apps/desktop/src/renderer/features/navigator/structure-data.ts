// What the navigator, index cards and outline share beyond the pure model: React hooks over the open script,
// revealing a scene in the editor, and the edits the three views make (moving, synopsis, color, section titles).
import { moveScenes, moveSection, scenesOf, setSceneColor, setSceneSynopsis, setSectionSynopsis, setSectionTitle, type ScreenplayDoc } from "@screenplay/engine";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { app } from "../../core/app.ts";
import { useEditor, useScript } from "../../core/hooks.ts";
import { usePagination } from "../print/live.ts";
import { dropAnchor, structureOf, type Edge, type ItemRef, type Structure } from "./structure-model.ts";

export { flattenOutline, type Edge, type FlatItem, type ItemRef, type Structure } from "./structure-model.ts";

/**
 * The structure of the open script, refreshed shortly after the document stops changing. Page numbers and
 * lengths come from the printed pagination (paper, printing settings, locked pages), as in print and reports.
 */
export function useStructure(delay = 200): Structure {
  const script = useScript(delay);
  // Reuse the live pagination. Re-paginating independently after each caret edit can block typing for >100 ms.
  const pagination = usePagination();
  return useMemo(() => structureOf(script, pagination ?? undefined), [script, pagination]);
}

/** The scene holding the caret, or null when there is no editor or the caret is outside every scene. */
export function useCaretScene(structure: Structure): string | null {
  const editor = useEditor();
  const [paragraphId, setParagraphId] = useState<string | null>(null);
  useEffect(() => {
    if (!editor) {
      setParagraphId(null);
      return;
    }
    setParagraphId(editor.currentParagraphId());
    return editor.onSelectionChange((selection) => setParagraphId(selection?.head.paragraphId ?? null));
  }, [editor]);
  return paragraphId ? structure.sceneOfParagraph(paragraphId) ?? null : null;
}

/**
 * Show a scene in the script view, switching to it first when another view is showing. The editor may be
 * mounted by the switch or may already exist from before it, so the reveal waits for the view change and then
 * runs twice: once straight away and once after the editor has had time to lay out.
 */
export function revealScene(headingId: string): void {
  const reveal = () => app.editor?.revealParagraph(headingId, { select: true });
  const hasScriptView = app.views.some((view) => view.id === "script");
  if (app.ui.view === "script" && app.editor) return reveal();
  if (app.ui.view === "script" || !hasScriptView) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    off();
    clearTimeout(timer);
  };
  const off = app.subscribe(() => {
    if (!app.editor || app.ui.view !== "script") return;
    stop();
    setTimeout(reveal, 0);
    setTimeout(reveal, 150);
  });
  timer = setTimeout(stop, 3000);
  app.setView("script");
}

/** Run a document edit from a view. A scene can be gone by the time a slow field commits; say so instead of throwing. */
function edit(change: (doc: ScreenplayDoc) => void): void {
  const session = app.session;
  try {
    session.edit(() => change(session.doc));
  } catch (error) {
    app.toast(error instanceof RangeError ? "That scene or section is no longer in the script."
      : error instanceof Error ? error.message : String(error), "error");
  }
}

/** Move a scene or section next to another one, as one undoable edit. */
export function moveByDrop(source: ItemRef, target: ItemRef, edge: Edge): void {
  edit((doc) => {
    const before = dropAnchor(app.session.script(), source, target, edge);
    if (source.kind === "scene") moveScenes(doc, [source.id], before);
    else moveSection(doc, source.id, before);
  });
}

/**
 * Option+arrow on a focused card or outline row moves that scene one place: the keyboard twin of dragging it.
 * Typing fields keep Option+arrow for moving by word.
 */
export function moveSceneByKey(event: KeyboardEvent<HTMLElement>, locked: boolean): void {
  if (locked || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const direction = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 0;
  const target = event.target as HTMLElement;
  if (!direction || target.closest("textarea, input, select, [contenteditable='true']")) return;
  const id = target.closest<HTMLElement>("[data-scene-id]")?.dataset.sceneId;
  if (!id) return;
  event.preventDefault();
  moveSceneBy(id, direction);
}

/**
 * Move a scene one place earlier or later. The order comes from the live script, not the debounced structure,
 * so pressing the key twice in quick succession moves the scene two places.
 */
export function moveSceneBy(sceneId: string, direction: -1 | 1): boolean {
  const scenes = scenesOf(app.session.script().paragraphs);
  const at = scenes.findIndex((scene) => scene.sceneId === sceneId);
  const neighbor = at < 0 ? undefined : scenes[at + direction];
  if (!neighbor) return false;
  moveByDrop({ kind: "scene", id: sceneId }, { kind: "scene", id: neighbor.sceneId }, direction < 0 ? "before" : "after");
  return true;
}

export function editSynopsis(item: ItemRef, text: string): void {
  edit((doc) => (item.kind === "scene" ? setSceneSynopsis(doc, item.id, text) : setSectionSynopsis(doc, item.id, text)));
}

export function editSceneColor(sceneId: string, color: string | null): void {
  edit((doc) => setSceneColor(doc, sceneId, color));
}

export function editSectionTitle(sectionId: string, title: string): void {
  edit((doc) => setSectionTitle(doc, sectionId, title));
}
