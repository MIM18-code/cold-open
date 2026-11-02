// Duplicate scene numbers: two writers adding a scene in the same locked gap both get 12A, an old draft was
// delivered with a number a new scene now reuses, or an imported file simply repeats one. Detection only tells
// the writer; resolution gives every scene in a gap its own number in script order, keeping every unique number
// as it was. Both peers find the same renumbering from the same merged document, so they never disagree.
import { plainText, type Paragraph, type Script } from "./model.ts";
import type { ScreenplayDoc } from "./doc.ts";
import { numberBetween } from "./pagination.ts";
import { compareSceneNumbers, numberAddedScenes } from "./structure.ts";
import { isOmitted, omittedParagraphs } from "./revisions.ts";

export interface SceneNumberConflict { number: string; headings: { id: string; heading: string }[]; }
const keyOf = (value: string) => value.trim().toUpperCase();
/** Detection only. Numbers are never changed without going through resolveSceneNumberConflicts. */
export function sceneNumberConflicts(paragraphs: readonly Paragraph[]): SceneNumberConflict[] {
  const numbers = new Map<string, SceneNumberConflict["headings"]>();
  for (const p of paragraphs) {
    if (p.type !== "sceneHeading" || !p.sceneNumber?.trim()) continue;
    const key = keyOf(p.sceneNumber), list = numbers.get(key) ?? [];
    list.push({ id: p.id, heading: plainText(p.runs) }); numbers.set(key, list);
  }
  return [...numbers].filter(([, headings]) => headings.length > 1).map(([number, headings]) => ({ number, headings }));
}
export function assertUniqueSceneNumbers(script: Script): void {
  const conflicts = sceneNumberConflicts(script.paragraphs);
  if (conflicts.length) throw new Error(`Duplicate scene numbers: ${conflicts.map((c) => c.number).join(", ")}. Review Production > Scene Number Conflicts before delivering this draft. Saving your working document remains available.`);
}

export interface SceneNumberChange {
  id: string;
  heading: string;
  from: string;
  to: string;
}

export interface SceneNumberResolution {
  /** Scenes that took a new number, in script order. */
  renumbered: SceneNumberChange[];
  /** Duplicates left after the resolution: a number could not be made unique safely. Delivery stays blocked on them. */
  conflicts: SceneNumberConflict[];
}

/** Notices the app opens after a resolution: one meta key per renumbered scene, so every writer sees the change. */
const RENUMBERING_KEY = "sceneNumberRenumbering:";

export type SceneNumberRenumbering = SceneNumberChange;

/**
 * Give duplicate scene numbers their own numbers, in script order: the first scene in a gap keeps the number and
 * the others take the next free ones (12A, 12B, 12AA, ...). Unique numbers never change, so numbers a locked or
 * delivered revision already issued stay put; when two scenes share a number, one of them has to change, and it
 * is always the one later in the script. Identical omissions collapse; different omission content stays for review.
 * Runs in one transaction. Returns what changed and what still conflicts.
 */
export function resolveSceneNumberConflicts(doc: ScreenplayDoc): SceneNumberResolution {
  const renumbered: SceneNumberChange[] = [];
  doc.ydoc.transact(() => {
    // A delayed Y.Text formatting update can clear a number after an earlier merge was repaired.
    numberAddedScenes(doc);
    reconcileOmissions(doc);
    for (const change of planRenumbering(doc.paragraphs())) {
      if (!doc.has(change.id) || doc.paragraph(change.id).sceneNumber !== change.from) continue;
      doc.setField(change.id, "sceneNumber", change.to);
      doc.meta.set(`${RENUMBERING_KEY}${change.id}`, { heading: change.heading, from: change.from, to: change.to });
      renumbered.push(change);
    }
  });
  return { renumbered, conflicts: sceneNumberConflicts(doc.paragraphs()) };
}

/** Concurrent omissions of the same unchanged scene keep one placeholder. Different content stays for review. */
function reconcileOmissions(doc: ScreenplayDoc): void {
  const paragraphs = doc.paragraphs();
  for (const conflict of sceneNumberConflicts(paragraphs)) {
    const headings = paragraphs.filter((p) => conflict.headings.some((h) => h.id === p.id));
    if (!headings.every(isOmitted)) continue;
    const original = omittedParagraphs(headings[0]!)[0]?.id;
    if (!original || !headings.every((p) => omittedParagraphs(p)[0]?.id === original)) continue;
    // The ID repair gives the second placeholder a new scene ID; all its other content must match.
    const content = (p: Paragraph) => JSON.stringify({ ...p, id: undefined, sceneId: undefined, sceneNumber: undefined });
    if (!headings.every((p) => content(p) === content(headings[0]!))) continue;
    for (const heading of headings.slice(1)) doc.deleteParagraph(heading.id);
  }
}

/**
 * The renumbering, worked out from the paragraphs alone so every replica of the same document finds the same one.
 * Each duplicate group keeps its first occurrence; later ones take the first free number between the scene before
 * and the next distinct number after, as numberBetween does for A-scenes.
 */
function planRenumbering(paragraphs: readonly Paragraph[]): SceneNumberChange[] {
  const headings = paragraphs.flatMap((p) => (p.type === "sceneHeading" && p.sceneNumber?.trim()
    ? [{ id: p.id, heading: plainText(p.runs), number: p.sceneNumber.trim(), raw: p.sceneNumber }]
    : []));
  const omitted = new Set(paragraphs.filter(isOmitted).map((p) => keyOf(p.sceneNumber ?? "")));
  const counts = new Map<string, number>();
  for (const heading of headings) counts.set(keyOf(heading.number), (counts.get(keyOf(heading.number)) ?? 0) + 1);
  const used = new Set<string>();
  for (const heading of headings) for (const form of [heading.number, heading.number.toUpperCase(), heading.number.toLowerCase()]) used.add(form);
  const seen = new Set<string>();
  const effective: string[] = [];
  const changes: SceneNumberChange[] = [];
  headings.forEach((heading, index) => {
    const key = keyOf(heading.number);
    if (omitted.has(key) || (counts.get(key) ?? 0) < 2 || !seen.has(key)) {
      seen.add(key);
      effective.push(heading.number);
      return;
    }
    const previous = index > 0 ? effective[index - 1] : undefined;
    let next: string | undefined;
    for (let i = index + 1; i < headings.length; i++) {
      const candidate = headings[i]!.number;
      if (keyOf(candidate) === key) continue;
      if (previous === undefined || compareSceneNumbers(candidate, previous) > 0) {
        next = candidate;
        break;
      }
    }
    let to = numberBetween(previous, next, used);
    // The neighbours may leave no letter free (all of 12A to 12Z used): keep appending one, 12A -> 12AA.
    for (let guard = 0; guard < 100 && used.has(to); guard++) to = `${to}A`;
    for (const form of [to, to.toUpperCase(), to.toLowerCase()]) used.add(form);
    effective.push(to);
    changes.push({ id: heading.id, heading: heading.heading, from: heading.raw, to });
  });
  return changes;
}

/** What a resolution renumbered since it ran: the notice the writer can open. Empty once dismissed or edited away. */
export function sceneNumberRenumberings(doc: ScreenplayDoc): SceneNumberRenumbering[] {
  const out: SceneNumberRenumbering[] = [];
  for (const key of doc.meta.keys()) {
    if (!key.startsWith(RENUMBERING_KEY)) continue;
    const id = key.slice(RENUMBERING_KEY.length);
    if (!doc.has(id)) continue;
    const value = doc.meta.get(key) as { heading?: unknown; from?: unknown; to?: unknown } | undefined;
    if (typeof value?.from !== "string" || typeof value.to !== "string") continue;
    if (doc.paragraph(id).sceneNumber !== value.to) continue;
    out.push({ id, heading: typeof value.heading === "string" ? value.heading : "", from: value.from, to: value.to });
  }
  return out;
}

/** Take the renumbering notice away. The numbers stay as they are. */
export function dismissSceneNumberRenumberings(doc: ScreenplayDoc): void {
  doc.ydoc.transact(() => {
    for (const key of [...doc.meta.keys()]) if (key.startsWith(RENUMBERING_KEY)) doc.meta.delete(key);
  });
}

/** The caller supplies the preview's old number and wraps this in one session edit/undo step. */
export function replaceSceneNumber(doc: ScreenplayDoc, id: string, expected: string, replacement: string): void {
  const next = keyOf(replacement), p = doc.has(id) ? doc.paragraph(id) : null;
  if (!p || p.type !== "sceneHeading" || p.sceneNumber !== expected) throw new Error("That scene number changed. Refresh the conflict list first.");
  if (!/^[A-Z0-9][A-Z0-9._-]{0,23}$/.test(next)) throw new Error("Use a scene number of up to 24 letters, digits, dots, underscores or hyphens.");
  if (doc.paragraphs().some((other) => other.type === "sceneHeading" && other.id !== id && keyOf(other.sceneNumber ?? "") === next))
    throw new Error("That scene number is already assigned to another scene.");
  doc.setField(id, "sceneNumber", next);
}
