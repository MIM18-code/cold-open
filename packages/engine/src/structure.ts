// Script structure: scenes as movable blocks, synopses, scene colors, per-scene summaries, the section outline
// and scene numbering. Reading functions take a plain Script. Editing functions take a ScreenplayDoc and run in
// one Yjs transaction, so a caller that wraps them in session.edit() gets one undo step.
//
// Moving. Yjs has no move operation. A move deletes the scene's text and inserts a copy of it, with every
// paragraph ID, scene ID and attribute unchanged, at the new place. Both steps happen in one transaction, so
// nothing local can observe the half-moved state. The limit is concurrency: a peer who types inside a scene
// while this move is in flight edits characters that this move deletes. Their new characters are not deleted
// (they did not exist yet), but they stay behind at the old position, outside the moved scene. The document
// stays valid and every ID stays unique; only that text ends up in the wrong place. The window is the time
// between this peer making the move and the other peer receiving it. Two peers moving the same scene at once
// each insert a copy; the document keeps both, and the later copy gets new paragraph and scene IDs on every
// peer (see doc.ts), so nothing either writer typed into either copy is lost.
// strandedByMove (structural-move-conflicts.ts) finds the left-behind text on the typist's replica when the move
// arrives, so their session can select it for manual cutting and pasting.
import * as Y from "yjs";
import type { ScreenplayDoc } from "./doc.ts";
import { MOVE_KNOWLEDGE_PREFIX, MOVE_KNOWLEDGE_LIMIT, moveDeletions, type MoveKnowledge } from "./move-knowledge.ts";
import { compareNumbers, numberBetween, paginate, sceneEighths, type Pagination } from "./pagination.ts";
import { NON_PRINTING, type FdxDocumentExtras, type Paragraph, type Script, type XmlNode, plainText } from "./model.ts";
import { characterName } from "./reports.ts";
import { sceneLetters, templateSceneNumbering } from "./template-rules.ts";

type DeltaOp = { insert: unknown; attributes?: Record<string, unknown> };

// ---- Scene blocks

export interface SceneBlock {
  sceneId: string;
  headingId: string;
  /** Index of the heading in the paragraph list, and one past the scene's last paragraph. */
  start: number;
  end: number;
}

/**
 * Scenes as blocks that can move. A scene runs from its heading to the next heading, except that a section
 * (an act or sequence title) ends it: the section and whatever follows it belong to the section, not to the
 * scene before it, so moving a scene never drags an act title along.
 */
export function sceneBlocks(paragraphs: readonly Paragraph[]): SceneBlock[] {
  const blocks: SceneBlock[] = [];
  let open: SceneBlock | undefined;
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.type === "sceneHeading") {
      if (open) open.end = index;
      open = { sceneId: paragraph.sceneId ?? paragraph.id, headingId: paragraph.id, start: index, end: paragraphs.length };
      blocks.push(open);
    } else if (paragraph.type === "section" && open) {
      open.end = index;
      open = undefined;
    }
  });
  return blocks;
}

/** Index in the paragraph list of a scene ID or paragraph ID; the list length for null ("at the end"). */
function anchorIndex(paragraphs: readonly Paragraph[], beforeId: string | null): number {
  if (beforeId === null) return paragraphs.length;
  const byScene = paragraphs.findIndex((p) => p.type === "sceneHeading" && (p.sceneId ?? p.id) === beforeId);
  const index = byScene >= 0 ? byScene : paragraphs.findIndex((p) => p.id === beforeId);
  if (index < 0) throw new RangeError(`No scene or paragraph with ID ${beforeId}.`);
  return index;
}

function sliceDelta(delta: readonly DeltaOp[], from: number, to: number): DeltaOp[] {
  const out: DeltaOp[] = [];
  let at = 0;
  for (const op of delta) {
    const length = typeof op.insert === "string" ? op.insert.length : 1;
    const start = Math.max(from, at), end = Math.min(to, at + length);
    if (end > start) {
      const insert = typeof op.insert === "string" ? op.insert.slice(start - at, end - at) : op.insert;
      out.push({ insert, ...(op.attributes ? { attributes: structuredClone(op.attributes) } : {}) });
    }
    at += length;
    if (at >= to) break;
  }
  return out;
}

/** Offset of each paragraph's leading line break in the body. */
function markerOffsets(doc: ScreenplayDoc, paragraphs: readonly Paragraph[]): number[] {
  if (!paragraphs.length) return [];
  let at = doc.range(paragraphs[0]!.id).start - 1;
  const offsets: number[] = [];
  for (const paragraph of paragraphs) {
    offsets.push(at);
    at += 1 + plainText(paragraph.runs).length;
  }
  // Never expected; the slow path asks the document for each position.
  return at === doc.body.length ? offsets : paragraphs.map((p) => doc.range(p.id).start - 1);
}

/** The paragraph order after moving index ranges to an anchor, as indexes into the old order. */
function movedOrder(count: number, ranges: readonly [number, number][], anchor: number): number[] {
  const moving = new Set<number>();
  for (const [start, end] of ranges) for (let i = start; i < end; i++) moving.add(i);
  const order: number[] = [];
  const moved = ranges.flatMap(([start, end]) => Array.from({ length: end - start }, (_, k) => start + k));
  for (let i = 0; i <= count; i++) {
    if (i === anchor) order.push(...moved);
    if (i < count && !moving.has(i)) order.push(i);
  }
  return order;
}

/** Move disjoint paragraph ranges (sorted, half-open) so they sit together before the paragraph at `anchor`. */
function moveRanges(doc: ScreenplayDoc, paragraphs: readonly Paragraph[], ranges: [number, number][], anchor: number): boolean {
  if (ranges.some(([start, end]) => anchor > start && anchor < end)) return false;
  if (movedOrder(paragraphs.length, ranges, anchor).every((value, index) => value === index)) return false;
  const markers = markerOffsets(doc, paragraphs);
  const total = doc.body.length;
  const at = (index: number) => (index < paragraphs.length ? markers[index]! : total);
  const delta = doc.body.toDelta() as DeltaOp[];
  const slices = ranges.map(([start, end]) => sliceDelta(delta, at(start), at(end)));
  let target = at(anchor);
  doc.ydoc.transact(transaction => {
    const before = Y.createDeleteSet();
    for (const [client, spans] of transaction.deleteSet.clients) before.clients.set(client, spans.map(span => ({ clock: span.clock, len: span.len })));
    const sv = btoa(Array.from(Y.encodeStateVector(doc.ydoc), byte => String.fromCharCode(byte)).join(""));
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [start, end] = ranges[i]!;
      const from = at(start), length = at(end) - from;
      doc.body.delete(from, length);
      if (from < target) target -= length;
    }
    doc.body.applyDelta([...(target > 0 ? [{ retain: target }] : []), ...slices.flat()]);
    const knowledge: MoveKnowledge = { sv, at: Y.getState(doc.ydoc.store, doc.ydoc.clientID), ...moveDeletions(doc, transaction, before) };
    const key = `${MOVE_KNOWLEDGE_PREFIX}${doc.ydoc.clientID}`, previous = doc.meta.get(key);
    doc.meta.set(key, [...(Array.isArray(previous) ? previous : []), knowledge].slice(-MOVE_KNOWLEDGE_LIMIT));
  });
  return true;
}

/**
 * Move scenes, kept in script order, so they sit together just before another scene. `beforeId` is a scene ID,
 * the ID of any paragraph (a section title, to land before the section), or null for the end of the script.
 * Every paragraph and scene ID is kept. Returns false when nothing changed (the scenes are already there).
 */
export function moveScenes(doc: ScreenplayDoc, sceneIds: readonly string[], beforeId: string | null): boolean {
  const paragraphs = doc.toScript().paragraphs;
  const wanted = new Set(sceneIds);
  const blocks = sceneBlocks(paragraphs);
  const chosen = blocks.filter((block) => wanted.has(block.sceneId));
  if (chosen.length !== wanted.size) throw new RangeError("Some of those scenes do not exist.");
  if (!chosen.length) return false;
  return moveRanges(doc, paragraphs, chosen.map((block): [number, number] => [block.start, block.end]), anchorIndex(paragraphs, beforeId));
}

export function moveScene(doc: ScreenplayDoc, sceneId: string, beforeId: string | null): boolean {
  return moveScenes(doc, [sceneId], beforeId);
}

/** A section runs to the next section of the same or a shallower depth, so it carries its subsections and scenes. */
function sectionRange(paragraphs: readonly Paragraph[], index: number): [number, number] {
  const depth = paragraphs[index]!.depth ?? 1;
  let end = index + 1;
  while (end < paragraphs.length && !(paragraphs[end]!.type === "section" && (paragraphs[end]!.depth ?? 1) <= depth)) end++;
  return [index, end];
}

/** Move a section with everything under it. `beforeId` is as for moveScenes. */
export function moveSection(doc: ScreenplayDoc, sectionId: string, beforeId: string | null): boolean {
  const paragraphs = doc.toScript().paragraphs;
  const index = paragraphs.findIndex((p) => p.id === sectionId && p.type === "section");
  if (index < 0) throw new RangeError(`No section with ID ${sectionId}.`);
  return moveRanges(doc, paragraphs, [sectionRange(paragraphs, index)], anchorIndex(paragraphs, beforeId));
}

/** The ID to pass as `beforeId` to land just after a scene: the paragraph that follows it, or null at the end of the script. */
export function sceneEndAnchor(script: Script, sceneId: string): string | null {
  const block = sceneBlocks(script.paragraphs).find((b) => b.sceneId === sceneId);
  if (!block) throw new RangeError(`No scene with ID ${sceneId}.`);
  return script.paragraphs[block.end]?.id ?? null;
}

/**
 * The ID to pass as `beforeId` to make a scene the first thing inside a section: the first paragraph after the
 * section's own synopsis and notes. Null when the section runs to the end of the script.
 */
export function sectionStartAnchor(script: Script, sectionId: string): string | null {
  const paragraphs = script.paragraphs;
  const index = paragraphs.findIndex((p) => p.id === sectionId);
  if (index < 0) throw new RangeError(`No paragraph with ID ${sectionId}.`);
  let next = index + 1;
  while (paragraphs[next] && (paragraphs[next]!.type === "synopsis" || paragraphs[next]!.type === "note")) next++;
  return paragraphs[next]?.id ?? null;
}

/**
 * The ID to pass as `beforeId` to make a scene the last thing inside a section: the next section of the same or
 * a shallower depth. Null when the section runs to the end of the script.
 */
export function sectionEndAnchor(script: Script, sectionId: string): string | null {
  const paragraphs = script.paragraphs;
  const index = paragraphs.findIndex((p) => p.id === sectionId && p.type === "section");
  if (index < 0) throw new RangeError(`No section with ID ${sectionId}.`);
  return paragraphs[sectionRange(paragraphs, index)[1]]?.id ?? null;
}

// ---- Text edits

/** Replace a paragraph's text, changing only the part that differs so formatting and cursors elsewhere survive. */
function replaceText(doc: ScreenplayDoc, id: string, next: string): void {
  const current = plainText(doc.paragraph(id).runs);
  if (current === next) return;
  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < current.length - prefix && suffix < next.length - prefix && current[current.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  doc.replaceText(id, prefix, current.length - suffix, next.slice(prefix, next.length - suffix));
}

function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

// ---- Synopsis

/** Index of the synopsis paragraph directly after a heading or section, or -1. */
function synopsisIndex(paragraphs: readonly Paragraph[], ownerIndex: number): number {
  return paragraphs[ownerIndex + 1]?.type === "synopsis" ? ownerIndex + 1 : -1;
}

function ownerIndexOfScene(paragraphs: readonly Paragraph[], sceneId: string): number {
  const index = paragraphs.findIndex((p) => p.type === "sceneHeading" && (p.sceneId ?? p.id) === sceneId);
  if (index < 0) throw new RangeError(`No scene with ID ${sceneId}.`);
  return index;
}

/** A scene's synopsis: the first synopsis paragraph right after its heading (the Fountain convention). */
export function sceneSynopsis(script: Script, sceneId: string): string {
  const { paragraphs } = script;
  const synopsis = paragraphs[synopsisIndex(paragraphs, ownerIndexOfScene(paragraphs, sceneId))];
  return synopsis ? plainText(synopsis.runs) : "";
}

/** Write a synopsis, keeping the paragraph (and its ID) when one exists. Empty text removes it. */
export function setSceneSynopsis(doc: ScreenplayDoc, sceneId: string, text: string): void {
  const { paragraphs } = doc.toScript();
  setSynopsisAfter(doc, paragraphs, ownerIndexOfScene(paragraphs, sceneId), text);
}

function setSynopsisAfter(doc: ScreenplayDoc, paragraphs: readonly Paragraph[], ownerIndex: number, text: string): void {
  const next = cleanText(text);
  const existing = synopsisIndex(paragraphs, ownerIndex);
  doc.ydoc.transact(() => {
    if (existing >= 0) {
      if (next) replaceText(doc, paragraphs[existing]!.id, next);
      else doc.deleteParagraph(paragraphs[existing]!.id);
    } else if (next) {
      doc.insertParagraph(ownerIndex + 1, { type: "synopsis", runs: [{ text: next }] });
    }
  });
}

/** Write a section's synopsis, the synopsis paragraph right after its title. Empty text removes it. */
export function setSectionSynopsis(doc: ScreenplayDoc, sectionId: string, text: string): void {
  const { paragraphs } = doc.toScript();
  const index = paragraphs.findIndex((p) => p.id === sectionId && p.type === "section");
  if (index < 0) throw new RangeError(`No section with ID ${sectionId}.`);
  setSynopsisAfter(doc, paragraphs, index, text);
}

// ---- Scene color

/** A scene's color is Final Draft's SceneProperties Color attribute, kept on the heading as raw FDX data. */
function scenePropertiesOf(paragraph: Paragraph): XmlNode | undefined {
  return paragraph.fdx?.before?.find((node) => node.name === "SceneProperties");
}

/** "#RRGGBB" or Final Draft's 16-bit "#RRRRGGGGBBBB" to "#RRGGBB"; undefined for anything else. */
function parseColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = /^#([0-9a-f]+)$/i.exec(value.trim())?.[1];
  if (hex?.length === 6) return `#${hex.toUpperCase()}`;
  if (hex?.length === 12) return `#${(hex.slice(0, 2) + hex.slice(4, 6) + hex.slice(8, 10)).toUpperCase()}`;
  return undefined;
}

/** A scene heading's color as "#RRGGBB", or undefined when it has none. */
export function sceneColor(heading: Paragraph): string | undefined {
  return parseColor(scenePropertiesOf(heading)?.attrs.find(([name]) => name === "Color")?.[1]);
}

function sixteenBit(color: string): string {
  return `#${color.slice(1).match(/../g)!.map((byte) => byte + byte).join("")}`.toUpperCase();
}

/** Set or clear (null) a scene's color. The heading's other FDX data is kept, so FDX export carries the color. */
export function setSceneColor(doc: ScreenplayDoc, sceneId: string, color: string | null): void {
  const next = color === null ? null : parseColor(color);
  if (next === undefined) throw new RangeError(`"${color}" is not a #RRGGBB color.`);
  const { paragraphs } = doc.toScript();
  const heading = paragraphs[ownerIndexOfScene(paragraphs, sceneId)]!;
  if ((sceneColor(heading) ?? null) === next) return;
  const fdx = structuredClone(heading.fdx ?? {});
  const before = fdx.before ?? [];
  let node = before.find((n) => n.name === "SceneProperties");
  if (next === null) {
    if (!node) return;
    node.attrs = node.attrs.filter(([name]) => name !== "Color");
    if (!node.attrs.length && !node.children.length) fdx.before = before.filter((n) => n !== node);
  } else {
    if (!node) before.unshift((node = { name: "SceneProperties", attrs: [], children: [] }));
    const old = node.attrs.find(([name]) => name === "Color")?.[1];
    const value = old !== undefined && old.length === 7 ? next : sixteenBit(next);
    node.attrs = [...node.attrs.filter(([name]) => name !== "Color"), ["Color", value]];
    // Final Draft writes attributes in alphabetical order.
    node.attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    fdx.before = before;
  }
  if (!fdx.before?.length) delete fdx.before;
  doc.setField(heading.id, "fdx", Object.keys(fdx).length ? fdx : undefined);
}

/** Colors in Final Draft's beat board picker, as "#RRGGBB". */
export const SCENE_COLORS: readonly { name: string; value: string }[] = [
  { name: "Red", value: "#E5484D" },
  { name: "Orange", value: "#F5A524" },
  { name: "Yellow", value: "#F1D52E" },
  { name: "Green", value: "#46A758" },
  { name: "Teal", value: "#12A594" },
  { name: "Blue", value: "#3E63DD" },
  { name: "Purple", value: "#8E4EC6" },
  { name: "Pink", value: "#E93D82" },
  { name: "Brown", value: "#A18072" },
  { name: "Gray", value: "#8B8D98" },
];

// ---- Scene headings and summaries

export interface SceneHeadingParts {
  /** "INT", "EXT", "INT/EXT" or "EST"; undefined when the heading has no such prefix. */
  setting?: string;
  location: string;
  timeOfDay?: string;
}

const SETTING = /^\s*\.?\s*(INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|I\s*\/\s*E\.?|INT\.?|EXT\.?|EST\.?)(?=[\s.\-–—]|$)[\s.\-–—]*(.*)$/i;
const TIME_WORDS = /\b(DAY|DAYS|NIGHT|NIGHTS|DAWN|DUSK|MORNING|AFTERNOON|EVENING|LATER|CONTINUOUS|SUNSET|SUNRISE|MIDNIGHT|NOON|TWILIGHT|SAME|MAGIC HOUR)\b/i;

/** Split "INT. KITCHEN - NIGHT" into setting, location and time of day. */
export function parseSceneHeading(heading: string): SceneHeadingParts {
  const match = SETTING.exec(heading);
  let setting: string | undefined;
  if (match) {
    const raw = match[1]!.replace(/[.\s]/g, "").toUpperCase();
    setting = raw === "EST" ? "EST" : raw === "INT" || raw === "EXT" ? raw : "INT/EXT";
  }
  const rest = (match ? match[2]! : heading).trim();
  const parts = rest.split(/\s+[-–—]\s+/);
  const last = parts.length > 1 ? parts.at(-1)!.trim() : "";
  const timeOfDay = last && TIME_WORDS.test(last) ? last : undefined;
  const location = (timeOfDay ? parts.slice(0, -1) : parts).join(" - ").trim();
  return { ...(setting ? { setting } : {}), location, ...(timeOfDay ? { timeOfDay } : {}) };
}


export interface SceneSummary {
  sceneId: string;
  headingId: string;
  /** Position in the script, from 0. */
  index: number;
  number?: string;
  heading: string;
  setting?: string;
  location: string;
  timeOfDay?: string;
  /** Characters who speak in the scene, in order of first cue. */
  characters: string[];
  /** Length in eighths of a page (the unit schedules use), and the printed page the scene starts on. */
  eighths: number;
  page?: string;
  words: number;
  synopsis: string;
  color?: string;
  paragraphCount: number;
}

function wordCount(paragraph: Paragraph): number {
  if (NON_PRINTING.has(paragraph.type)) return 0;
  let words = 0;
  for (const run of paragraph.runs) if (!run.note) words += run.text.match(/\S+/g)?.length ?? 0;
  return words;
}

/**
 * One summary per scene, in script order. Page lengths come from pagination; pass one that was already
 * computed to avoid laying out the script again.
 */
export function sceneSummaries(script: Script, options: { pagination?: Pagination } = {}): SceneSummary[] {
  const { paragraphs } = script;
  const blocks = sceneBlocks(paragraphs);
  if (!blocks.length) return [];
  const pagination = options.pagination ?? paginate(script);
  const eighths = sceneEighths(script, pagination);
  return blocks.map((block, index) => {
    const heading = paragraphs[block.start]!;
    const text = plainText(heading.runs);
    const characters: string[] = [];
    let words = 0;
    for (let i = block.start; i < block.end; i++) {
      const paragraph = paragraphs[i]!;
      words += wordCount(paragraph);
      if (paragraph.type === "character") {
        const name = characterName(plainText(paragraph.runs));
        if (name && !characters.includes(name)) characters.push(name);
      }
    }
    const synopsis = paragraphs[synopsisIndex(paragraphs, block.start)];
    const color = sceneColor(heading);
    const position = pagination.positions.get(heading.id);
    const parts = parseSceneHeading(text);
    return {
      sceneId: block.sceneId, headingId: heading.id, index,
      ...(heading.sceneNumber !== undefined ? { number: heading.sceneNumber } : {}),
      heading: text, ...parts, characters,
      eighths: eighths.get(block.sceneId) ?? 0,
      ...(position ? { page: pagination.pages[position.page]?.number } : {}),
      words, synopsis: synopsis ? plainText(synopsis.runs) : "",
      ...(color ? { color } : {}),
      paragraphCount: block.end - block.start,
    };
  });
}

// ---- Outline

export interface OutlineSection {
  kind: "section";
  /** The section paragraph's ID. */
  id: string;
  depth: number;
  title: string;
  synopsis: string;
  children: OutlineNode[];
}

export interface OutlineScene {
  kind: "scene";
  sceneId: string;
  headingId: string;
}

export type OutlineNode = OutlineSection | OutlineScene;

/** Sections (Fountain's # lines) with the scenes and deeper sections under them. Scenes before any section are at the top. */
export function outlineOf(script: Script): OutlineNode[] {
  const { paragraphs } = script;
  const top: OutlineNode[] = [];
  const stack: OutlineSection[] = [];
  const add = (node: OutlineNode) => (stack.at(-1)?.children ?? top).push(node);
  let scenes = 0;
  const blocks = sceneBlocks(paragraphs);
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.type === "section") {
      const depth = Math.max(1, paragraph.depth ?? 1);
      while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
      const synopsis = paragraphs[synopsisIndex(paragraphs, index)];
      const section: OutlineSection = {
        kind: "section", id: paragraph.id, depth, title: plainText(paragraph.runs).replace(/\n/g, " "),
        synopsis: synopsis ? plainText(synopsis.runs) : "", children: [],
      };
      add(section);
      stack.push(section);
    } else if (paragraph.type === "sceneHeading") {
      const block = blocks[scenes++]!;
      add({ kind: "scene", sceneId: block.sceneId, headingId: block.headingId });
    }
  });
  return top;
}

export function addSection(doc: ScreenplayDoc, options: { title?: string; depth?: number; beforeId?: string | null } = {}): string {
  const { paragraphs } = doc.toScript();
  const index = anchorIndex(paragraphs, options.beforeId ?? null);
  const title = cleanText(options.title ?? "").replace(/\n/g, " ");
  return doc.insertParagraph(index, {
    type: "section", depth: Math.max(1, options.depth ?? 1), runs: title ? [{ text: title }] : [],
  });
}

export function setSectionTitle(doc: ScreenplayDoc, sectionId: string, title: string): void {
  if (doc.paragraph(sectionId).type !== "section") throw new RangeError(`Paragraph ${sectionId} is not a section.`);
  replaceText(doc, sectionId, cleanText(title).replace(/\n/g, " "));
}

/** Remove a section title and its synopsis. Its scenes stay where they are, under the section before it. */
export function removeSection(doc: ScreenplayDoc, sectionId: string): void {
  const { paragraphs } = doc.toScript();
  const index = paragraphs.findIndex((p) => p.id === sectionId && p.type === "section");
  if (index < 0) throw new RangeError(`No section with ID ${sectionId}.`);
  const synopsis = paragraphs[synopsisIndex(paragraphs, index)];
  doc.ydoc.transact(() => {
    if (synopsis) doc.deleteParagraph(synopsis.id);
    doc.deleteParagraph(sectionId);
  });
}

// ---- Scene numbers

/** Set every scene heading's number; `numbersFor` gets the current numbers in script order and returns the new ones. */
function setSceneNumbers(doc: ScreenplayDoc, numbersFor: (current: (string | undefined)[]) => (string | undefined)[]): number {
  const paragraphs = doc.paragraphs();
  const headings = paragraphs.flatMap((paragraph, index) => (paragraph.type === "sceneHeading" ? [index] : []));
  const numbers = numbersFor(headings.map((index) => paragraphs[index]!.sceneNumber));
  const markers = markerOffsets(doc, paragraphs);
  let changed = 0;
  doc.ydoc.transact(() => {
    headings.forEach((index, k) => {
      const next = numbers[k];
      if (paragraphs[index]!.sceneNumber === next) return;
      doc.body.format(markers[index]!, 1, { sceneNumber: next ?? null });
      changed++;
    });
  });
  return changed;
}

// ----- The scene number lock in FDX -------------------------------------------------------------------------

/**
 * Final Draft has no field for the scene number lock. These two attributes on its SceneNumberOptions element carry
 * it through an FDX file that Cold Open writes and reads back. Final Draft 13 drops both when it saves (checked
 * 2026-11-01), and it rewrites paragraph IDs, so after a Final Draft round trip the numbers survive but the lock does
 * not. ColdOpenLockedScenes lists the numbers the locked draft had already issued as JSON [[paragraph ID, number],
 * ...], so a writer can tell a delivered number from a new one.
 */
export const SCENE_LOCK_ATTR = "ColdOpenSceneNumbersLocked";
export const SCENE_LOCKED_NUMBERS_ATTR = "ColdOpenLockedScenes";

type LockedSceneNumbers = [id: string, number: string][];

const fdxAttr = (node: XmlNode, name: string) => node.attrs.find(([key]) => key === name)?.[1];

function sceneNumberOptions(extras: FdxDocumentExtras | undefined): XmlNode | undefined {
  return extras ? [...extras.before, ...extras.after].find((node) => node.name === "SceneNumberOptions") : undefined;
}

const lockFromFile = new WeakMap<object, boolean | undefined>();

/** The lock an FDX file records through the attributes above, or undefined when it records none. */
export function sceneNumberLockFromFdx(extras: FdxDocumentExtras | undefined): boolean | undefined {
  if (!extras) return undefined;
  if (lockFromFile.has(extras)) return lockFromFile.get(extras);
  const node = sceneNumberOptions(extras);
  const value = node ? fdxAttr(node, SCENE_LOCK_ATTR)?.trim().toLowerCase() : undefined;
  const locked = value === "yes" ? true : value === "no" ? false : undefined;
  lockFromFile.set(extras, locked);
  return locked;
}

/** The numbers an FDX file records as issued, tied to the paragraphs that carry them. */
export function issuedSceneNumbersFromFdx(extras: FdxDocumentExtras | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const node = sceneNumberOptions(extras);
  const raw = node ? fdxAttr(node, SCENE_LOCKED_NUMBERS_ATTR)?.trim() : undefined;
  if (!raw) return out;
  try {
    const pairs = JSON.parse(raw) as unknown;
    if (!Array.isArray(pairs)) return out;
    for (const pair of pairs) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string" && pair[1].trim()) out.set(pair[0], pair[1].trim());
    }
  } catch {
    // Not ours, or damaged: the file simply records no numbers.
  }
  return out;
}

/** The numbered scenes a locked FDX file issues: paragraph ID to number, in script order. */
export function lockedSceneNumbersOf(doc: ScreenplayDoc): Map<string, string> {
  const out = new Map<string, string>();
  for (const paragraph of doc.paragraphs()) {
    if (paragraph.type === "sceneHeading" && paragraph.sceneNumber?.trim()) out.set(paragraph.id, paragraph.sceneNumber.trim());
  }
  return out;
}

/** The numbers the last Final Draft file this document came from recorded as issued. */
export function issuedSceneNumbers(doc: ScreenplayDoc): Map<string, string> {
  return issuedSceneNumbersFromFdx(doc.meta.get("fdx") as FdxDocumentExtras | undefined);
}

/** Write the lock into FDX extras (a copy): set its attributes, or take them off when the scene numbers are free. */
export function writeSceneNumberLock(extras: FdxDocumentExtras, locked: boolean, numbers: ReadonlyMap<string, string> = new Map()): void {
  const lists = [extras.before, extras.after];
  let node = lists.flat().find((element) => element.name === "SceneNumberOptions");
  if (!node) {
    if (!locked) return;
    node = { name: "SceneNumberOptions", attrs: [], children: [] };
    extras.after.push(node);
  }
  const others = node.attrs.filter(([name]) => name !== SCENE_LOCK_ATTR && name !== SCENE_LOCKED_NUMBERS_ATTR);
  if (locked) {
    const pairs: LockedSceneNumbers = [...numbers].map(([id, number]): [string, string] => [id, number]);
    const added: [string, string][] = [[SCENE_LOCK_ATTR, "Yes"], [SCENE_LOCKED_NUMBERS_ATTR, JSON.stringify(pairs)]];
    node.attrs = [...others, ...added].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return;
  }
  node.attrs = others;
  if (node.attrs.length || node.children.length) return;
  // An element the app made only for the lock: leave none behind.
  for (const candidate of lists) {
    const index = candidate.indexOf(node);
    if (index >= 0) candidate.splice(index, 1);
  }
}

/**
 * Locked scene numbers: kept in the document meta, and in FDX through the SceneNumberOptions attributes above.
 * A file that came from this app reads the lock from them; unlocking records "No" in the meta so the file's
 * lock does not come back.
 */
export function sceneNumbersLocked(doc: ScreenplayDoc): boolean {
  const own = doc.meta.get("sceneNumbersLocked");
  if (own !== undefined) return own === true;
  return sceneNumberLockFromFdx(doc.meta.get("fdx") as FdxDocumentExtras | undefined) === true;
}

/** Lock or unlock scene numbers. Unlocking changes no number; Number Scenes then renumbers 1 to N. */
export function setSceneNumbersLocked(doc: ScreenplayDoc, locked: boolean): void {
  doc.meta.set("sceneNumbersLocked", locked);
}

/** Order of two scene numbers: 1 < 2 < 12 < 12A < 12AA < 12B < 13, and A1 < B1 < 1. */
export function compareSceneNumbers(a: string, b: string): number {
  return compareNumbers(a, b);
}

/** The number for a scene added between two numbered scenes while numbers are locked (12A after 12, A1 before 1). */
export function sceneNumberBetween(previous: string | undefined, next: string | undefined, used: ReadonlySet<string> = new Set()): string {
  return numberBetween(previous, next, used);
}

/** Numbers for unnumbered scenes that keep every existing number: each new scene gets an A-number from its neighbours. */
export function lockedSceneNumbers(current: readonly (string | undefined)[]): (string | undefined)[] {
  if (!current.some((number) => number !== undefined)) return [...current];
  const normalized = current.map((number) => number?.trim().toUpperCase());
  const used = new Set(normalized.filter((number): number is string => number !== undefined));
  const out = [...current];
  out.forEach((number, k) => {
    if (number !== undefined) return;
    const previous = out.slice(0, k).findLast((value) => value !== undefined)?.trim().toUpperCase();
    const next = normalized.slice(k + 1).find((value) => value !== undefined);
    out[k] = numberBetween(previous, next, used);
    used.add(out[k]!);
  });
  return out;
}

/** A letter between two scene letters: A, AA, AB before B. Used when a multi-camera script's numbers are locked. */
function letterBetween(previous: string | undefined, next: string | undefined, used: ReadonlySet<string>): string {
  // A bounded search: a room full of neighbours can use many labels, but never more than this.
  if (previous === undefined) {
    for (let k = 0; k < 702; k++) {
      const candidate = sceneLetters(k);
      if (!used.has(candidate) && (next === undefined || candidate < next)) return candidate;
    }
    const base = `A${next ?? ""}`;
    let candidate = base, n = 0;
    while (used.has(candidate)) candidate = `${base}${sceneLetters(n++)}`;
    return candidate;
  }
  for (let k = 0; k < 702; k++) {
    const candidate = previous + sceneLetters(k);
    if (!used.has(candidate) && (next === undefined || candidate < next)) return candidate;
  }
  const base = `${previous}A`;
  let candidate = base, n = 0;
  while (used.has(candidate)) candidate = `${base}${sceneLetters(n++)}`;
  return candidate;
}

/** Locked scene letters: keep A, B and C and give scenes added since the next free letter after the one before them. */
export function lockedSceneLetters(current: readonly (string | undefined)[]): (string | undefined)[] {
  if (!current.some((number) => number !== undefined)) return [...current];
  const used = new Set(current.filter((number): number is string => number !== undefined));
  const out = [...current];
  out.forEach((number, k) => {
    if (number !== undefined) return;
    const previous = out.slice(0, k).findLast((value) => value !== undefined);
    const next = current.slice(k + 1).find((value) => value !== undefined);
    out[k] = letterBetween(previous, next, used);
    used.add(out[k]!);
  });
  return out;
}

/**
 * Number every scene 1 to N in script order, replacing numbers already there. A multi-camera document numbers
 * A, B, C instead, and keeps that alphabet while its numbers are locked. Returns how many headings changed.
 */
export function numberScenes(doc: ScreenplayDoc): number {
  const letters = templateSceneNumbering(doc.meta.get("template")) === "letters";
  if (sceneNumbersLocked(doc)) return setSceneNumbers(doc, letters ? lockedSceneLetters : lockedSceneNumbers);
  return setSceneNumbers(doc, (current) => current.map((_, k) => (letters ? sceneLetters(k) : String(k + 1))));
}

/**
 * While scene numbers are locked, give A-numbers to the scenes added since: unnumbered headings that have text.
 * An empty heading waits for its text, so a line that only passes through Scene Heading takes no number. Returns
 * how many headings changed; nothing while numbers are unlocked.
 */
export function numberAddedScenes(doc: ScreenplayDoc): number {
  if (!sceneNumbersLocked(doc)) return 0;
  const letters = templateSceneNumbering(doc.meta.get("template")) === "letters";
  const paragraphs = doc.paragraphs();
  const waiting = paragraphs.filter((p) => p.type === "sceneHeading").map((p) => p.sceneNumber === undefined && !plainText(p.runs).trim());
  return setSceneNumbers(doc, (current) => {
    const counted = current.filter((_, k) => !waiting[k]);
    const numbered = letters ? lockedSceneLetters(counted) : lockedSceneNumbers(counted);
    let next = 0;
    return current.map((number, k) => (waiting[k] ? number : numbered[next++]));
  });
}

/** Clear every scene number. Returns how many headings changed. Refuses while scene numbers are locked. */
export function removeSceneNumbers(doc: ScreenplayDoc): number {
  if (sceneNumbersLocked(doc)) throw new RangeError("Scene numbers are locked. Unlock them first.");
  return setSceneNumbers(doc, (current) => current.map(() => undefined));
}
