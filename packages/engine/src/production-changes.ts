import type { Script } from "./model.ts";
import type { Pagination } from "./pagination.ts";
import { sceneBlocks, sceneSummaries } from "./structure.ts";
import { isOmitted } from "./revisions.ts";
import { tagDefinitions } from "./tags.ts";

export const BACKLOT_BASELINE = "backlot.handoffBaseline";
export interface ProductionScene {
  sceneId: string;
  headingId: string;
  number?: string;
  heading: string;
  omitted: boolean;
  characters: string[];
  tags: { id: string; category: string; label: string }[];
  eighths: number;
}
export interface ProductionSnapshot { version: 1; scenes: ProductionScene[] }
export interface BacklotBaseline extends ProductionSnapshot { sentAt: string; projectId: string; revision?: number }
export type ProductionChangeKind = "added" | "omitted" | "restored" | "moved" | "heading" | "characters" | "tags" | "length";
export interface ProductionChange {
  sceneId: string;
  kinds: ProductionChangeKind[];
  before: ProductionScene | null;
  after: ProductionScene | null;
  previousPosition: number | null;
  position: number | null;
  eighthsDelta: number;
  review?: { scheduled: boolean; issuedCallSheet: boolean; needsBacklotReview: boolean };
}
export interface ProductionChanges { version: 1; baselineSentAt: string | null; scenes: ProductionChange[] }

export function productionSnapshot(script: Script, pagination?: Pagination): ProductionSnapshot {
  const definitions = new Map(tagDefinitions(script).map(d => [d.number, d]));
  const blocks = sceneBlocks(script.paragraphs);
  return { version: 1, scenes: sceneSummaries(script, { pagination }).map((scene, i) => {
    const block = blocks[i]!, tags = new Map<string, ProductionScene["tags"][number]>();
    for (const p of script.paragraphs.slice(block.start, block.end)) for (const run of p.runs) {
      if (run.note) continue;
      const number = run.fdx?.TagNumber;
      if (!number) continue;
      const d = definitions.get(number);
      const tag = d ? { id: d.id || `number:${number}`, category: d.category, label: d.label }
        : { id: `number:${number}`, category: "Unresolved category", label: number };
      tags.set(tag.id, tag);
    }
    return { sceneId: scene.sceneId, headingId: scene.headingId, number: scene.number, heading: scene.heading,
      omitted: isOmitted(script.paragraphs[block.start]!), characters: [...scene.characters].sort(),
      tags: [...tags.values()].sort((a, b) => a.id.localeCompare(b.id)), eighths: scene.eighths };
  }) };
}

/** Metadata and IPC snapshots are untrusted, including native documents from collaborators. */
export function isProductionSnapshot(value: unknown): value is ProductionSnapshot {
  const v = value as ProductionSnapshot | undefined;
  return !!v && v.version === 1 && Array.isArray(v.scenes) && v.scenes.length <= 10000 &&
    new Set(v.scenes.map(s => s?.sceneId)).size === v.scenes.length && v.scenes.every(s => s &&
      [s.sceneId, s.headingId, s.heading].every(t => typeof t === "string" && t.length <= 20000) &&
      (s.number === undefined || typeof s.number === "string") && typeof s.omitted === "boolean" &&
      Number.isSafeInteger(s.eighths) && s.eighths >= 0 && Array.isArray(s.characters) && s.characters.every(c => typeof c === "string") &&
      Array.isArray(s.tags) && s.tags.every(t => t && [t.id, t.category, t.label].every(x => typeof x === "string")));
}
export function backlotBaseline(value: unknown): BacklotBaseline | null {
  const v = value as BacklotBaseline;
  return isProductionSnapshot(v) && typeof v.sentAt === "string" && typeof v.projectId === "string" &&
    (v.revision === undefined || Number.isSafeInteger(v.revision) && v.revision >= 0) ? v : null;
}

export function backlotChanges(baseline: BacklotBaseline | null, current: ProductionSnapshot): ProductionChanges {
  const old = baseline?.scenes ?? [], beforeById = new Map(old.map(s => [s.sceneId, s]));
  const afterById = new Map(current.scenes.map(s => [s.sceneId, s]));
  // Insertions and deletions alone do not move surviving scenes.
  const oldOrder = old.filter(s => afterById.has(s.sceneId)).map(s => s.sceneId);
  const newOrder = current.scenes.filter(s => beforeById.has(s.sceneId)).map(s => s.sceneId);
  const oldPositions = new Map(oldOrder.map((id, i) => [id, i]));
  const newPositions = new Map(newOrder.map((id, i) => [id, i]));
  const ids = [...current.scenes.map(s => s.sceneId), ...old.filter(s => !afterById.has(s.sceneId)).map(s => s.sceneId)];
  const scenes: ProductionChange[] = [];
  for (const id of ids) {
    const before = beforeById.get(id) ?? null, after = afterById.get(id) ?? null;
    const kinds: ProductionChangeKind[] = [];
    if (!before) kinds.push("added");
    else if (!after) kinds.push("omitted");
    else {
      if (before.omitted !== after.omitted) kinds.push(after.omitted ? "omitted" : "restored");
      if (oldPositions.get(id) !== newPositions.get(id)) kinds.push("moved");
      if (before.heading !== after.heading) kinds.push("heading");
      if (JSON.stringify(before.characters) !== JSON.stringify(after.characters)) kinds.push("characters");
      if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) kinds.push("tags");
      if (before.eighths !== after.eighths) kinds.push("length");
    }
    if (kinds.length) scenes.push({ sceneId: id, kinds, before, after,
      previousPosition: before ? old.indexOf(before) + 1 : null, position: after ? current.scenes.indexOf(after) + 1 : null,
      eighthsDelta: (after?.eighths ?? 0) - (before?.eighths ?? 0) });
  }
  return { version: 1, baselineSentAt: baseline?.sentAt ?? null, scenes };
}
