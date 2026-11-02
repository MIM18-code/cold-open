// Drag and drop for reordering scenes and sections, shared by the navigator, index cards and outline. Each view
// is a "surface": items only accept drags that started on the same surface, so a view and the navigator showing
// together never both handle one drop.
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements, monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useEffect, useRef, useState } from "react";

import type { Edge, ItemRef } from "./structure-data.ts";

export type Surface = "navigator" | "cards" | "outline";

function edgeOf(element: Element, input: { clientX: number; clientY: number }, axis: "x" | "y"): Edge {
  const rect = element.getBoundingClientRect();
  return axis === "x"
    ? (input.clientX < rect.left + rect.width / 2 ? "before" : "after")
    : (input.clientY < rect.top + rect.height / 2 ? "before" : "after");
}

/**
 * Make an element a drop target for other items on its surface, and optionally draggable itself.
 * `edge` is where a drop would land relative to this item while something is dragged over it.
 */
export function useReorderItem<T extends HTMLElement>(surface: Surface, item: ItemRef, options: { drag?: boolean; axis?: "x" | "y" } = {}) {
  const { drag = true, axis = "y" } = options;
  const ref = useRef<T>(null);
  const [edge, setEdge] = useState<Edge | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Once a text field has focus, a drag inside it selects text instead of picking up the whole row. An unfocused
    // field still drags the row, so a card can be grabbed by its synopsis.
    const holdFields = (event: MouseEvent) => {
      if (!event.target || event.target !== document.activeElement || !(event.target as Element).matches("input, textarea")) return;
      element.draggable = false;
      window.addEventListener("mouseup", () => { element.draggable = true; }, { once: true, capture: true });
    };
    if (drag) element.addEventListener("mousedown", holdFields, true);
    const cleanup = combine(
      ...(drag ? [draggable({
        element,
        getInitialData: () => ({ surface, kind: item.kind, id: item.id }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      })] : []),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => source.data.surface === surface && !(source.data.kind === item.kind && source.data.id === item.id),
        getData: ({ input, element: target }) => ({ surface, kind: item.kind, id: item.id, edge: edgeOf(target, input, axis) }),
        onDrag: ({ self }) => setEdge(self.data.edge as Edge),
        onDragLeave: () => setEdge(null),
        onDrop: () => setEdge(null),
      }),
    );
    return () => {
      element.removeEventListener("mousedown", holdFields, true);
      cleanup();
    };
  }, [surface, item.kind, item.id, drag, axis]);
  return { ref, edge, dragging };
}

/** Classes for the drop indicator and the dimmed source, from useReorderItem's state. */
export function reorderClass(state: { edge: Edge | null; dragging: boolean }, axis: "x" | "y" = "y"): string {
  return [`structure-axis-${axis}`, state.edge ? `structure-drop-${state.edge}` : "", state.dragging ? "structure-dragging" : ""].filter(Boolean).join(" ");
}

/** Call back once per completed drop on a surface. */
export function useReorderMonitor(surface: Surface, onDrop: (source: ItemRef, target: ItemRef, edge: Edge) => void): void {
  const latest = useRef(onDrop);
  latest.current = onDrop;
  useEffect(() => monitorForElements({
    canMonitor: ({ source }) => source.data.surface === surface,
    onDrop: ({ source, location }) => {
      const target = location.current.dropTargets[0]?.data;
      if (!target) return;
      latest.current(
        { kind: source.data.kind as ItemRef["kind"], id: source.data.id as string },
        { kind: target.kind as ItemRef["kind"], id: target.id as string },
        target.edge as Edge,
      );
    },
  }), [surface]);
}
