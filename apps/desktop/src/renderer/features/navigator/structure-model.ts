// The derived structure of a script, and where a drop should land, as plain functions of a Script. No app or
// DOM imports, so desktop unit tests can run it in Node.
import {
  outlineOf, paginate, sceneBlocks, sceneEndAnchor, sceneSummaries, sectionEndAnchor, sectionStartAnchor,
  type OutlineNode, type OutlineSection, type Pagination, type SceneSummary, type Script,
} from "@screenplay/engine";

export interface Structure {
  script: Script;
  /** The pagination these summaries use: pages, lengths and positions come from it. */
  pagination: Pagination;
  summaries: SceneSummary[];
  scenes: Map<string, SceneSummary>;
  outline: OutlineNode[];
  /** The scene a paragraph belongs to, if any. Section titles and text before the first heading belong to none. */
  sceneOfParagraph(paragraphId: string): string | undefined;
}

const cache = new WeakMap<object, Structure>();

/**
 * Derived once per script object (or per pagination of it, when one is given), so the navigator and a view
 * showing at the same time share the work. Without a pagination, pages follow the default layout.
 */
export function structureOf(script: Script, pagination?: Pagination): Structure {
  const key = pagination ?? script;
  let structure = cache.get(key);
  if (!structure) {
    const pages = pagination ?? paginate(script);
    const summaries = sceneSummaries(script, { pagination: pages });
    let owner: Map<string, string> | undefined;
    structure = {
      script, pagination: pages, summaries, scenes: new Map(summaries.map((s) => [s.sceneId, s])), outline: outlineOf(script),
      sceneOfParagraph(paragraphId) {
        if (!owner) {
          owner = new Map();
          for (const block of sceneBlocks(script.paragraphs)) {
            for (let i = block.start; i < block.end; i++) owner.set(script.paragraphs[i]!.id, block.sceneId);
          }
        }
        return owner.get(paragraphId);
      },
    };
    cache.set(key, structure);
  }
  return structure;
}

export type FlatItem =
  | { kind: "section"; section: OutlineSection; level: number }
  | { kind: "scene"; sceneId: string; level: number };

/** The outline in reading order with each item's nesting level: sections and scenes as one list. */
export function flattenOutline(nodes: readonly OutlineNode[], level = 0, out: FlatItem[] = []): FlatItem[] {
  for (const node of nodes) {
    if (node.kind === "scene") out.push({ kind: "scene", sceneId: node.sceneId, level });
    else {
      out.push({ kind: "section", section: node, level });
      flattenOutline(node.children, level + 1, out);
    }
  }
  return out;
}

export type Edge = "before" | "after";
export interface ItemRef {
  kind: "scene" | "section";
  id: string;
}

/**
 * The `beforeId` that makes a drop of `source` land on `edge` of `target`. A scene dropped on the lower half of a
 * section goes first inside it; a section dropped there goes after the whole target section.
 */
export function dropAnchor(script: Script, source: ItemRef, target: ItemRef, edge: Edge): string | null {
  if (target.kind === "scene") return edge === "before" ? target.id : sceneEndAnchor(script, target.id);
  if (edge === "before") return target.id;
  return source.kind === "scene" ? sectionStartAnchor(script, target.id) : sectionEndAnchor(script, target.id);
}
