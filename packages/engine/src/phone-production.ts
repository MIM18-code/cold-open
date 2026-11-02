import type { ScreenplayDoc } from "./doc.ts";
import { plainText, type Paragraph } from "./model.ts";
import { tagDefinitions, type TagDefinition } from "./tags.ts";
import { sceneBlocks } from "./structure.ts";
import { deletionMarks, importedDeletionMarks, isOmitted, pageLocks, revisedRanges, revisionState, type RevisionSet } from "./revisions.ts";

export interface PhoneProduction {
  v: 2;
  active: RevisionSet | null;
  sets: RevisionSet[];
  scenes: { id: string; number: string; heading: string; changes: string[]; color: string | null }[];
  marks: Record<string, { color: string; label: string }>;
  lockedPages: string[];
}

/** Baseline is the first publication in this document session, scoped to its revision set. */
export function productionChanges(doc: ScreenplayDoc, baseline?: readonly Paragraph[], baselineTags?: readonly TagDefinition[]): PhoneProduction {
  const state = revisionState(doc), paragraphs = doc.paragraphs();
  const active = state.sets.find(s => s.id === state.currentSetId) ?? null;
  const script = doc.toScript(), deletions = importedDeletionMarks(script);
  const marks: PhoneProduction["marks"] = {};
  const scenes: PhoneProduction["scenes"] = [];
  const locks = pageLocks(doc) ?? [];
  const tags = (ps: readonly Paragraph[], definitions: readonly TagDefinition[]) => JSON.stringify(ps.flatMap(p => p.runs
    .filter(r => r.fdx?.TagNumber || r.fdx?.InklotTagId)
    .map(r => [r.text, r.fdx?.TagNumber, r.fdx?.InklotTagId, definitions.find(d => r.fdx?.InklotTagId ? d.id === r.fdx.InklotTagId : d.number === r.fdx?.TagNumber)])));
  const previous = new Map(sceneBlocks(baseline ?? []).map(b => [b.sceneId, baseline!.slice(b.start, b.end)]));
  const definitions = tagDefinitions(script);
  let sceneNumber = 0;
  for (const block of sceneBlocks(paragraphs)) {
    sceneNumber++;
    const ps = paragraphs.slice(block.start, block.end), heading = ps[0]!;
    const before = previous.get(block.sceneId), changes: string[] = [];
    for (const p of ps) {
      const ids = [...revisedRanges(p), ...deletionMarks(p), ...(deletions.get(p.id) ?? [])].map(r => r.setId);
      const set = state.sets.findLast(s => ids.includes(s.id));
      if (set) marks[p.id] = { color: set.color, label: set.name };
    }
    if (ps.some(p => marks[p.id])) changes.push("Revised text");
    if (before && JSON.stringify(before.map(p => [p.type, plainText(p.runs)])) !== JSON.stringify(ps.map(p => [p.type, plainText(p.runs)]))) changes.push("Scene changed");
    if (baseline && !before) changes.push("Added scene");
    if (isOmitted(heading)) changes.push("Omitted");
    if (/[A-Z]/i.test(heading.sceneNumber ?? "")) changes.push("A-scene");
    const pages = locks.filter(l => ps.some(p => p.id === l.paragraphId || l.paragraphIds?.includes(p.id))).map(l => l.number);
    if (pages.length) changes.push(`Locked pages ${pages.join(", ")}`);
    if (before && tags(before, baselineTags ?? definitions) !== tags(ps, definitions)) changes.push("Breakdown tags changed");
    if (changes.length) scenes.push({ id: heading.id, number: heading.sceneNumber ?? String(sceneNumber),
      heading: plainText(heading.runs), changes, color: ps.map(p => marks[p.id]?.color).find(Boolean) ?? active?.color ?? null });
  }
  return { v: 2, active, sets: state.sets, scenes, marks, lockedPages: locks.map(l => l.number) };
}

export function isPhoneProduction(value: unknown): value is PhoneProduction {
  if (!value || typeof value !== "object") return false;
  const p = value as PhoneProduction;
  const revision = (s: RevisionSet) => !!s && typeof s.id === "string" && typeof s.name === "string"
    && /^#[\da-f]{6}$/i.test(s.color) && typeof s.mark === "string";
  return p.v === 2 && Array.isArray(p.sets) && p.sets.every(revision)
    && (p.active === null || revision(p.active))
    && Array.isArray(p.scenes) && p.scenes.every(s => !!s && typeof s.id === "string"
      && typeof s.number === "string" && typeof s.heading === "string"
      && (s.color === null || /^#[\da-f]{6}$/i.test(s.color))
      && Array.isArray(s.changes) && s.changes.every(c => typeof c === "string"))
    && !!p.marks && typeof p.marks === "object" && !Array.isArray(p.marks)
    && Object.values(p.marks).every(m => !!m && typeof m.label === "string" && /^#[\da-f]{6}$/i.test(m.color))
    && Array.isArray(p.lockedPages) && p.lockedPages.every(n => typeof n === "string");
}
