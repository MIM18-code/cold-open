// The story map: the script as a horizontal page timeline, and the structure points a writer places on it.
//
// A point's target is a fraction of the script's pages, not a page number, so the target keeps its meaning when
// the script grows or shrinks: "Midpoint" stays halfway. The fraction goes from the top of page 1 (0) to the end
// of the last page (1). A point can be pinned to a scene; the map then compares the target with the page the
// scene actually starts on and reports the difference in pages.
//
// Points live in the document's metadata, one entry per field, so co-writers sync them and the native
// .screenplay format keeps them. Final Draft has no field for them, so FDX export leaves them out.
import type { ScreenplayDoc } from "./doc.ts";
import { linesPerPage } from "./layout.ts";
import type { Pagination } from "./pagination.ts";
import { deletionMarks, revisedRanges, type RevisionSet, type RevisionState } from "./revisions.ts";
import { sceneBlocks, sceneSummaries, type SceneSummary } from "./structure.ts";
import { newId } from "./ids.ts";
import type { Script } from "./model.ts";

/** Meta key prefix: each point field is an independent CRDT entry. */
export const STRUCTURE_POINT_PREFIX = "structurePoint.";

export interface StructurePoint {
  id: string;
  name: string;
  /** Target as a fraction of the script's pages: 0 at the top of page 1, 1 at the end of the last page. */
  position: number;
  /** The scene the point is pinned to, if any. */
  sceneId?: string;
}

export function clampPosition(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Where a target falls on the timeline, in pages from the top of page 1. A script of 100 pages puts 50% at 50
 * pages in: the top of page 51, which is halfway through the paper.
 */
export function pointOffset(position: number, pages: number): number {
  return clampPosition(position) * Math.max(0, pages);
}

/** The page a target falls on, using printed labels when supplied. */
export function pointPage(position: number, pages: number): number;
export function pointPage(position: number, pages: number, labels: readonly string[]): string;
export function pointPage(position: number, pages: number, labels?: readonly string[]): number | string {
  if (labels) {
    const offset = Math.min(Math.max(0, pages - 1), Math.round(pointOffset(position, pages) * 10) / 10);
    const fraction = offset % 1;
    return `${labels[Math.floor(offset)] ?? "1"}${fraction ? fraction.toFixed(1).slice(1) : ""}`;
  }
  if (pages <= 0) return 1;
  return Math.min(pages, pointOffset(position, pages) + 1);
}

/** The target fraction for a physical page, 1 to the last page. */
export function pagePosition(page: number, pages: number): number {
  if (pages <= 1) return 0;
  return clampPosition((page - 1) / pages);
}

/**
 * How far a scene sits from its target, in pages. Positive means the scene comes later than the point: the beat
 * is late. `sceneStart` is the scene's offset on the timeline, as storyMap reports it.
 */
export function pageDelta(position: number, sceneStart: number, pages: number): number {
  return sceneStart - pointOffset(position, pages);
}

/**
 * Read a target written either as a page ("p. 61", "61", "61.5", "2A") or as a share of the script ("50%").
 * A bare number is a page. Returns undefined for anything else.
 */
export function parsePointPosition(text: string, pages: number, labels?: readonly string[]): number | undefined {
  const value = text.trim();
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(value);
  if (percent) return clampPosition(Number.parseFloat(percent[1]!) / 100);
  if (labels) {
    const page = value.replace(/^(?:page\s*|p\.?\s*)/i, "").toUpperCase();
    const exact = labels.findIndex((label) => label.toUpperCase() === page);
    if (exact >= 0) return pages > 0 ? exact / pages : 0;
    const fractional = /^(.*)(\.\d+)$/.exec(page);
    if (!fractional) return undefined;
    const index = labels.findIndex((label) => label.toUpperCase() === fractional[1]);
    return index >= 0 && pages > 0 ? clampPosition((index + Number(fractional[2])) / pages) : undefined;
  }
  const page = /^(?:p\.?|page\s*)?\s*(\d+(?:\.\d+)?)$/i.exec(value);
  if (!page) return undefined;
  return pagePosition(Number.parseFloat(page[1]!), pages);
}

/** "p. 61", "p. 61.5" or "p. 2A", the page a target lands on. */
export function formatPointPage(page: number | string): string {
  return `p. ${typeof page === "string" || Number.isInteger(page) ? page : page.toFixed(1)}`;
}

function cleanName(text: string): string {
  return text.replace(/\s+/g, " ").trim() || "Untitled point";
}

function readPoint(doc: ScreenplayDoc, id: string): StructurePoint | undefined {
  const key = STRUCTURE_POINT_PREFIX + id;
  const rawName = doc.meta.get(`${key}.name`);
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) return undefined;
  const rawPosition = doc.meta.get(`${key}.position`);
  const position = typeof rawPosition === "number" ? clampPosition(rawPosition) : 0;
  const rawSceneId = doc.meta.get(`${key}.sceneId`);
  const sceneId = typeof rawSceneId === "string" && rawSceneId ? rawSceneId : undefined;
  return {
    id,
    name,
    position,
    ...(sceneId ? { sceneId } : {}),
  };
}

/** Every structure point in the document, in target order. */
export function structurePoints(doc: ScreenplayDoc): StructurePoint[] {
  const points: StructurePoint[] = [];
  for (const key of doc.meta.keys()) {
    if (!key.startsWith(STRUCTURE_POINT_PREFIX) || !key.endsWith(".name")) continue;
    const id = key.slice(STRUCTURE_POINT_PREFIX.length, -".name".length);
    if (!id) continue;
    const point = readPoint(doc, id);
    if (point) points.push(point);
  }
  return points.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function store(doc: ScreenplayDoc, point: StructurePoint): void {
  const key = STRUCTURE_POINT_PREFIX + point.id;
  doc.ydoc.transact(() => {
    doc.meta.set(`${key}.name`, point.name);
    doc.meta.set(`${key}.position`, point.position);
    if (point.sceneId) doc.meta.set(`${key}.sceneId`, point.sceneId);
    else doc.meta.delete(`${key}.sceneId`);
  });
}

export function addStructurePoint(
  doc: ScreenplayDoc,
  init: { name?: string; position?: number; sceneId?: string | null } = {},
): StructurePoint {
  const point: StructurePoint = {
    id: newId(),
    name: init.name === undefined ? "New point" : cleanName(init.name),
    position: clampPosition(init.position ?? 0.5),
    ...(init.sceneId ? { sceneId: init.sceneId } : {}),
  };
  store(doc, point);
  return point;
}

/** Change a point. A null sceneId unpins it; an empty name becomes "Untitled point". */
export function updateStructurePoint(
  doc: ScreenplayDoc,
  id: string,
  patch: { name?: string; position?: number; sceneId?: string | null },
): StructurePoint {
  const key = STRUCTURE_POINT_PREFIX + id;
  if (!readPoint(doc, id)) throw new RangeError(`No structure point with ID ${id}.`);
  doc.ydoc.transact(() => {
    if (patch.name !== undefined) doc.meta.set(`${key}.name`, cleanName(patch.name));
    if (patch.position !== undefined) doc.meta.set(`${key}.position`, clampPosition(patch.position));
    if (patch.sceneId !== undefined) {
      if (patch.sceneId) doc.meta.set(`${key}.sceneId`, patch.sceneId);
      else doc.meta.delete(`${key}.sceneId`);
    }
  });
  return readPoint(doc, id)!;
}

export function removeStructurePoint(doc: ScreenplayDoc, id: string): boolean {
  const prefix = `${STRUCTURE_POINT_PREFIX}${id}.`;
  const existed = doc.meta.has(`${prefix}name`);
  doc.ydoc.transact(() => {
    for (const key of doc.meta.keys()) if (key.startsWith(prefix)) doc.meta.delete(key);
  });
  return existed;
}

export interface StructurePointPreset {
  id: string;
  name: string;
  points: readonly { name: string; position: number }[];
}

/**
 * Starting layouts. "Three-act" is the classical turns; "Beat sheet" is the common commercial beat structure,
 * named for what it is rather than for a book.
 */
export const STRUCTURE_POINT_PRESETS: readonly StructurePointPreset[] = [
  {
    id: "threeAct",
    name: "Three-act",
    points: [
      { name: "Inciting Incident", position: 0.1 },
      { name: "First Act Turn", position: 0.25 },
      { name: "Midpoint", position: 0.5 },
      { name: "Second Act Turn", position: 0.75 },
      { name: "Climax", position: 0.9 },
    ],
  },
  {
    id: "beatSheet",
    name: "Beat sheet",
    points: [
      { name: "Opening Image", position: 0.01 },
      { name: "Catalyst", position: 0.1 },
      { name: "Break Into Two", position: 0.2 },
      { name: "Midpoint", position: 0.5 },
      { name: "All Is Lost", position: 0.75 },
      { name: "Dark Night", position: 0.8 },
      { name: "Break Into Three", position: 0.85 },
      { name: "Finale", position: 0.95 },
    ],
  },
];

/** Add a preset's missing points, keeping existing points with the same name. Returns the points it added. */
export function addStructurePointPreset(doc: ScreenplayDoc, presetId: string): StructurePoint[] {
  const preset = STRUCTURE_POINT_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) throw new RangeError(`No structure point preset with ID ${presetId}.`);
  const taken = new Set(structurePoints(doc).map((point) => point.name.toLowerCase()));
  const added: StructurePoint[] = [];
  for (const spec of preset.points) {
    const id = `beat-${spec.name.toLowerCase().replace(/\s+/g, "-")}`;
    if (doc.meta.has(`${STRUCTURE_POINT_PREFIX}${id}.name`) || taken.has(spec.name.toLowerCase())) continue;
    const point = { id, name: spec.name, position: spec.position };
    store(doc, point);
    added.push(point);
    taken.add(spec.name.toLowerCase());
  }
  return added;
}

// ---- The map

export interface StoryMapScene {
  sceneId: string;
  headingId: string;
  /** Position on the timeline in pages from the top of page 1. */
  start: number;
  /** Pages long: to the next scene, or to the end of the script. */
  length: number;
  /** The printed page the scene starts on. */
  page: string;
  /** Length in eighths, as the cards and navigator show it. */
  eighths: number;
  number?: string;
  heading: string;
  /** Final Draft's scene color, "#RRGGBB". */
  color?: string;
  /** The latest revision set on the scene's pages, if any. */
  revision?: RevisionSet;
}

export interface StoryMap {
  /** Printed pages in the script. */
  pages: number;
  pageLabels: string[];
  scenes: StoryMapScene[];
}

/**
 * Lay the scenes out on the page timeline. Blocks tile the script: one runs until the next scene starts, and the
 * last runs to the end. The revision on a block is the latest set with revised text or a deletion inside that
 * scene, so a shared page does not color the scene before it. A view that already has the scene summaries passes
 * them in, so the script is not scanned twice.
 */
export function storyMap(
  script: Script,
  pagination: Pagination,
  revisions?: RevisionState,
  summaries?: readonly SceneSummary[],
): StoryMap {
  const pages = pagination.pages.length;
  const pageLabels = pagination.pages.map((page) => page.number);
  const sceneList = summaries ?? sceneSummaries(script, { pagination });
  if (!sceneList.length || !pages) return { pages, pageLabels, scenes: [] };
  const blocks = sceneBlocks(script.paragraphs);
  const perPage = linesPerPage(pagination.layout.page);
  const starts = sceneList.map((summary) => {
    const at = pagination.positions.get(summary.headingId);
    if (!at) return 0;
    return Math.min(pages, Math.max(0, at.page + at.line / Math.max(1, perPage)));
  });
  const rank = new Map((revisions?.sets ?? []).map((set, index) => [set.id, index]));
  return {
    pages,
    pageLabels,
    scenes: sceneList.map((summary, index) => {
      const start = starts[index]!;
      const end = index + 1 < sceneList.length ? starts[index + 1]! : pages;
      let latest: RevisionSet | undefined;
      const note = (id: string) => {
        if (!revisions) return;
        const set = revisions.sets.find((candidate) => candidate.id === id);
        if (set && (!latest || (rank.get(set.id) ?? -1) > (rank.get(latest.id) ?? -1))) latest = set;
      };
      const block = blocks[index];
      if (block) {
        for (const paragraph of script.paragraphs.slice(block.start, block.end)) {
          for (const range of revisedRanges(paragraph)) note(range.setId);
          for (const mark of deletionMarks(paragraph)) note(mark.setId);
        }
      }
      return {
        sceneId: summary.sceneId,
        headingId: summary.headingId,
        start,
        length: Math.max(0, end - start),
        page: pageLabels[pagination.positions.get(summary.headingId)?.page ?? 0] ?? "1",
        eighths: summary.eighths,
        ...(summary.number !== undefined ? { number: summary.number } : {}),
        heading: summary.heading,
        ...(summary.color ? { color: summary.color } : {}),
        ...(latest ? { revision: latest } : {}),
      };
    }),
  };
}
