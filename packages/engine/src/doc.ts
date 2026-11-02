// The collaborative screenplay document. The whole script is one Y.Text. Each paragraph starts with
// a line break, and the paragraph's ID, type and other fields are formatting attributes on that line
// break. A paragraph's identity lives on its own leading break and is never copied: splitting inserts
// a new break with a new ID, joining deletes a break. Concurrent splits, joins and typing therefore
// merge without losing text or duplicating IDs. Scenes are derived from scene headings.
//
// Layout inside the Y.Doc (schema 2):
//   meta  Y.Map   schema, titlePage, fdx (document-level FDX data kept for export); the production state
//                 (revisions, pageLocks, fdxDeletedText) has keys of its own, see revisions.ts
//   body  Y.Text  "\n" + text for each paragraph. Characters carry run attributes (bold, italic,
//                 underline, strikeout, allCaps, styleExtra, note, "fdx:<attr>"); each leading "\n"
//                 carries paragraph attributes (id, type, sceneId, sceneNumber, dual, alignment,
//                 startsNewPage, depth, boneyard, fdx). A line break inside a paragraph is a "\n"
//                 with the attribute soft: true.
//
// Reading the paragraph list means walking the whole Y.Text, which is too slow to do on every keystroke
// of a long script. The list is cached and the cache is stamped with the Y.Doc's clock and the body's
// length (every insert advances the clock and every delete of text shortens the body). Deleting only
// formatting moves neither (undoing Bold, or a co-writer clearing a field), so a body change in a
// transaction the cache did not record also marks it stale. The editing methods below patch the cache in
// place for edits inside one paragraph; anything else, including undo and remote updates, rebuilds it,
// keeping the objects of paragraphs that did not change.
//
// Repeated and missing paragraph IDs. Yjs has no move, so moving a scene (structure.ts) deletes it and inserts a
// copy with the same IDs. Two writers moving the same scene at once leave two copies. Undo makes more: undoing a
// move deletes the copy and puts back the deleted text, and two writers who both undo put it back twice, the two
// restorations interleaved item by item, sometimes with a line break whose ID attribute was not restored.
//
// The repair never deletes. After any transaction that adds or restores a line break or changes an ID attribute,
// each peer gives every later copy of an ID, and every line break without one, a new ID made from the Yjs ID of
// that line break's own character ("y<client>-<clock>"). Every peer has the same characters, so every peer makes
// the same IDs, and two peers making the same change at once converge. Which copy keeps an ID: the paragraph
// whose own line break that ID was made from, if it is there, otherwise the first in document order (Yjs orders
// items the same way on every peer). A heading that gets a new ID takes it as its scene ID too, and a repeated
// scene ID is replaced the same way. The writer sees both copies and decides; listeners of onRepair are told.
//
// Lost paragraph types. Y.Text keeps each attribute as a marker before the characters it applies to, and a
// deletion removes markers it makes redundant. When a co-writer's text lands between a marker and the line break it
// belonged to (one writer presses Return at the end of a section title and moves the next scene away while another
// moves a scene in before the following section), a line break can end up with no type, which reads as General on
// every peer. The repair then gives it a type back, in the same formatting-only way: the type of another copy of
// the paragraph if there is one, otherwise sceneHeading when it has a scene ID and section when it has a depth, so
// a scene heading or an act or sequence title keeps its place in the structure. Any other paragraph stays General.
//
// Rejected designs. Deleting all copies but the first (the first version) loses text: it deleted a copy holding
// accepted typing when an undo put an older copy back ahead of it, and it lets a later undo or redo, which
// recorded the copy the repair deleted, remove the last copy of a scene. Deleting only copies identical to the
// kept one fails the same way: the kept copy can then go by an undo whose redo no longer brings back what the
// repair deleted. Merging the copies' differing text into one has no clear answer when two restorations
// interleave item by item. Undoing a move as a reverse move would avoid the restorations, but typing undone after
// it refers to the characters the move deleted, which only Yjs's own undo brings back. Keeping both copies is
// the only repair that cannot lose text, at the price of a second copy to delete when two writers move the same
// scene at the same moment. Tested in test/structure.test.ts with three writers moving, typing, undoing and
// redoing, their updates delivered late and out of order.
import * as Y from "yjs";
import { MOVE_KNOWLEDGE_PREFIX } from "./move-knowledge.ts";

import { newId } from "./ids.ts";
import {
  MARKS, type ElementType, type Paragraph, type Run, type Scene, type Script, isElementType, normalizeRuns, plainText, scenesOf,
} from "./model.ts";
import { fdxExtras } from "./revisions.ts";
import { captureScriptNotes, projectScriptNotes, SCRIPT_NOTE_ANCHORS } from "./script-notes.ts";
import { isTemplateId } from "./template-rules.ts";

import { projectTags, PROJECT_TAG_PREFIX } from "./tags.ts";

export const SCHEMA_VERSION = 2;

const OPTIONAL_FIELDS = ["sceneId", "sceneNumber", "dual", "alignment", "startsNewPage", "depth", "boneyard", "fdx"] as const;
type OptionalField = (typeof OPTIONAL_FIELDS)[number];
const FDX_PREFIX = "fdx:";

/** Transaction origin of the ID repair. Not a local edit, so undo leaves it alone. */
export const REPAIR_ORIGIN = Symbol("repair");

/** What one ID repair changed (see the top of this file). */
export interface RepairReport {
  /** New IDs of paragraphs that were a second copy of another paragraph's ID. Their text is unchanged. */
  copies: string[];
  /** The text of the scene headings among those copies, so the writer can be told which scenes are doubled. */
  headings: string[];
  /** Line breaks that had no ID and got one. */
  missing: number;
  /** Paragraphs that had lost their type and got it back (see the top of this file); left out when none did. */
  types?: number;
}

/** Paragraph attributes whose change can repeat or drop an ID, or drop a type. */
const ID_KEYS = new Set(["id", "sceneId", "soft", "type"]);

/** The ID made from a line break's own Yjs character ID: the same on every peer, and never a UUID. */
function idFromItem(client: number, clock: number): string {
  return `y${client}-${clock}`;
}

export type Marks = Partial<Record<(typeof MARKS)[number], boolean>>;
type Attributes = Record<string, unknown>;

/** A caret position in the script: a paragraph and a character offset into its text. */
export interface TextPosition {
  paragraphId: string;
  offset: number;
}

function runAttributes(run: Run): Attributes {
  const attributes: Attributes = {};
  for (const mark of MARKS) if (run[mark]) attributes[mark] = true;
  if (run.styleExtra) attributes.styleExtra = run.styleExtra;
  if (run.note) attributes.note = true;
  for (const [key, value] of Object.entries(run.fdx ?? {})) attributes[FDX_PREFIX + key] = value;
  return attributes;
}

function toRun(text: string, attributes: Attributes = {}): Run {
  const run: Run = { text };
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if ((MARKS as readonly string[]).includes(key)) run[key as (typeof MARKS)[number]] = true;
    else if (key === "styleExtra" && typeof value === "string") run.styleExtra = value;
    else if (key === "note") run.note = true;
    else if (key.startsWith(FDX_PREFIX) && typeof value === "string") (run.fdx ??= {})[key.slice(FDX_PREFIX.length)] = value;
  }
  return run;
}

/** Delta inserts for run text: "\n" inside a paragraph becomes a soft line break. */
function textInserts(text: string, attributes: Attributes): { insert: string; attributes: Attributes }[] {
  return text.split(/(\n)/).filter(Boolean).map((part) => ({ insert: part, attributes: part === "\n" ? { ...attributes, soft: true } : attributes }));
}

function paragraphAttributes(paragraph: Paragraph): Attributes {
  const attributes: Attributes = { id: paragraph.id, type: paragraph.type };
  for (const field of OPTIONAL_FIELDS) {
    if (paragraph[field] !== undefined) attributes[field] = structuredClone(paragraph[field]);
  }
  return attributes;
}

/** The runs between two character offsets. */
export function cutRuns(runs: readonly Run[], from: number, to = Infinity): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const start = Math.max(from, at), end = Math.min(to, at + run.text.length);
    if (end > start) out.push({ ...run, text: run.text.slice(start - at, end - at), ...(run.fdx ? { fdx: { ...run.fdx } } : {}) });
    at += run.text.length;
  }
  return out;
}

function equalValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every((key) => equalValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function cloneParagraph(paragraph: Paragraph): Paragraph {
  const copy: Paragraph = { ...paragraph, runs: paragraph.runs.map((run) => ({ ...run, ...(run.fdx ? { fdx: { ...run.fdx } } : {}) })) };
  if (paragraph.dual) copy.dual = { ...paragraph.dual };
  if (paragraph.fdx) copy.fdx = structuredClone(paragraph.fdx);
  return copy;
}

interface Entry {
  paragraph: Paragraph;
  /** Offset of the paragraph's leading line break, and one past its last character. */
  start: number;
  end: number;
  /** Its line break has no element type (see the top of this file); it reads as General. */
  untyped?: boolean;
}

/** The type a paragraph that lost it gets back when no other copy of it has one, or undefined to stay General. */
function structuralType(paragraph: Paragraph): ElementType | undefined {
  if (paragraph.sceneId !== undefined) return "sceneHeading";
  if (paragraph.depth !== undefined) return "section";
  return undefined;
}

interface Cache {
  entries: Entry[];
  /** The first entry for each ID. */
  ids: Map<string, number>;
  /** Some paragraph ID appears more than once or is missing, a scene ID repeats or a type was lost: the repair has work. */
  repeats: boolean;
  clock: number;
  length: number;
  paragraphs?: Paragraph[];
}

function newEntry(attributes: Attributes, start: number): Entry & { runs: Run[] } {
  const type = attributes.type;
  const paragraph: Paragraph = { id: typeof attributes.id === "string" ? attributes.id : "", type: isElementType(type) ? type : "general", runs: [] };
  for (const field of OPTIONAL_FIELDS) {
    const value = attributes[field];
    if (value !== undefined && value !== null) (paragraph as unknown as Record<OptionalField, unknown>)[field] = structuredClone(value);
  }
  return { paragraph, start, end: start, runs: [], ...(isElementType(type) ? {} : { untyped: true }) };
}

/** A paragraph's fields after a format() of its line break, as newEntry would read them back. */
function withAttributes(paragraph: Paragraph, change: Attributes): Paragraph {
  const next: Paragraph = { ...paragraph };
  for (const [key, value] of Object.entries(change)) {
    if (key === "type") next.type = value as ElementType;
    else if (value === null || value === undefined) delete (next as unknown as Record<string, unknown>)[key];
    else (next as unknown as Record<string, unknown>)[key] = structuredClone(value);
  }
  return next;
}

/** A pasted copy of a paragraph: new IDs, no scene number, dual blocks renamed through `blocks`. */
function freshCopy(paragraph: Paragraph, blocks: Map<string, string>): Paragraph {
  const copy = cloneParagraph(paragraph);
  copy.id = newId();
  delete copy.sceneNumber;
  if (copy.type === "sceneHeading") copy.sceneId = copy.id;
  else delete copy.sceneId;
  if (copy.dual) {
    const block = blocks.get(copy.dual.block) ?? newId();
    blocks.set(copy.dual.block, block);
    copy.dual = { block, side: copy.dual.side };
  }
  if (copy.fdx?.dualWrapper) delete copy.fdx.dualWrapper;
  return copy;
}

/**
 * The transaction may have repeated or dropped a paragraph or scene ID: it added a line break (typed, pasted or put
 * back by undo), or added or removed an ID attribute. Typing inside a paragraph does neither, so it skips the repair.
 */
function touchesIds(transaction: Y.Transaction, body: Y.Text): boolean {
  const store = transaction.doc.store;
  for (const [client, clock] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (clock <= from) continue;
    const structs = store.clients.get(client)!;
    for (let i = Y.findIndexSS(structs, from); i < structs.length; i++) {
      const item = structs[i];
      if (!(item instanceof Y.Item) || item.parent !== body) continue;
      if (item.content instanceof Y.ContentFormat ? ID_KEYS.has(item.content.key) : item.content instanceof Y.ContentString && item.content.str.includes("\n")) return true;
    }
  }
  let removed = false;
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, (item) => {
    if (!removed && item instanceof Y.Item && item.parent === body && item.content instanceof Y.ContentFormat && ID_KEYS.has(item.content.key)) removed = true;
  });
  return removed;
}

export interface DocOptions {
  /** Give repeated and missing paragraph IDs new IDs after transactions that can cause them (see the top of this file and setRepairs). Default true. */
  repair?: boolean;
}

export class ScreenplayDoc {
  readonly ydoc: Y.Doc;
  private cache: Cache | undefined;
  /** Transactions whose body changes patch() recorded in the cache. */
  private readonly patched = new WeakSet<Y.Transaction>();
  private repairs: boolean;
  private readonly repairListeners = new Set<(report: RepairReport) => void>();

  constructor(ydoc: Y.Doc = new Y.Doc(), options: DocOptions = {}) {
    this.ydoc = ydoc;
    this.repairs = options.repair !== false;
    // Before observers run, so a view reading paragraphs() in its observer never sees the old list.
    ydoc.on("beforeObserverCalls", (transaction: Y.Transaction) => {
      const changed = transaction.changed as Map<unknown, unknown>;
      if (this.cache && changed.has(this.body) && !this.patched.has(transaction)) this.cache.clock = -1;
    });
    // Local, remote and undo transactions alike. Typing touches no ID, so it skips the check.
    ydoc.on("afterTransaction", (transaction: Y.Transaction) => {
      if (!this.repairs || transaction.origin === REPAIR_ORIGIN || !(transaction.changed as Map<unknown, unknown>).has(this.body)) return;
      if (touchesIds(transaction, this.body)) this.repairDuplicates();
    });
  }

  /**
   * Whether this copy repairs repeated and missing paragraph IDs itself (on by default). A read-only follower turns
   * it off: its repairs never reach the writers, and the copy it keeps an ID on can differ from theirs when it saw a
   * different set of copies. The writers' repairs reach it instead. Turning it on repairs at once.
   */
  setRepairs(on: boolean): void {
    const was = this.repairs;
    this.repairs = on;
    if (on && !was) this.repairDuplicates();
  }

  static fromScript(script: Script, ydoc?: Y.Doc): ScreenplayDoc {
    const doc = new ScreenplayDoc(ydoc);
    doc.load(script);
    return doc;
  }

  static fromUpdate(update: Uint8Array): ScreenplayDoc {
    const doc = new ScreenplayDoc();
    doc.applyUpdate(update);
    if (!doc.meta.has(SCRIPT_NOTE_ANCHORS)) captureScriptNotes(doc);
    return doc;
  }

  get meta(): Y.Map<unknown> {
    return this.ydoc.getMap("meta");
  }

  /** The script text. Editor bindings attach here. */
  get body(): Y.Text {
    return this.ydoc.getText("body");
  }

  /** Replace the whole document with a script, in one transaction. */
  load(script: Script): void {
    this.ydoc.transact(() => {
      for (const key of this.meta.keys()) if (key.startsWith(PROJECT_TAG_PREFIX) || key.startsWith(MOVE_KNOWLEDGE_PREFIX)) this.meta.delete(key);
      this.meta.set("schema", SCHEMA_VERSION);
      this.meta.set("titlePage", structuredClone(script.titlePage));
      if (script.fdx) this.meta.set("fdx", structuredClone(script.fdx));
      else this.meta.delete("fdx");
      if (script.template) this.meta.set("template", script.template);
      else this.meta.delete("template");
      this.body.delete(0, this.body.length);
      const delta: { insert: string; attributes: Attributes }[] = [];
      for (const paragraph of script.paragraphs) {
        delta.push({ insert: "\n", attributes: paragraphAttributes(paragraph) });
        for (const run of normalizeRuns(paragraph.runs)) delta.push(...textInserts(run.text, runAttributes(run)));
      }
      this.body.applyDelta(delta);
      captureScriptNotes(this);
    });
  }

  /** Sum of every client's clock. Inserts and formatting advance it; deletes do not, but they shorten the body. */
  private clock(): number {
    let clock = 0;
    for (const structs of this.ydoc.store.clients.values()) {
      const last = structs[structs.length - 1];
      if (last) clock += last.id.clock + last.length;
    }
    return clock;
  }

  private fresh(): Cache | undefined {
    const cache = this.cache;
    return cache && cache.length === this.body.length && cache.clock === this.clock() ? cache : undefined;
  }

  /** The cached paragraph list, rebuilt when the document changed since it was read. */
  private entries(): Entry[] {
    const cached = this.fresh();
    if (cached) return cached.entries;
    const previous = this.cache?.entries;
    const entries = this.readEntries();
    if (previous) {
      const old = new Map(previous.map((entry) => [entry.paragraph.id, entry.paragraph]));
      for (const entry of entries) {
        const before = old.get(entry.paragraph.id);
        if (before && equalValue(before, entry.paragraph)) entry.paragraph = before;
      }
    }
    const ids = new Map<string, number>();
    const scenes = new Set<string>();
    let repeats = false;
    entries.forEach((entry, index) => {
      const { id, type, sceneId } = entry.paragraph;
      if (!id || ids.has(id)) repeats = true;
      if (entry.untyped) repeats = true;
      // A paragraph with no ID stays reachable as "" until the repair gives it one: a read-only follower never does.
      if (!ids.has(id)) ids.set(id, index);
      if (type === "sceneHeading" && sceneId !== undefined) {
        if (scenes.has(sceneId)) repeats = true;
        scenes.add(sceneId);
      }
    });
    this.cache = { entries, ids, repeats, clock: this.clock(), length: this.body.length };
    return entries;
  }

  /**
   * Every paragraph with its position. Text before the first line break (the lead) appears when one writer removes
   * or moves the first paragraph or scene while another types in it. It is read as the start of the first paragraph,
   * so every peer agrees and nothing is lost, and text offsets in that paragraph count it too, as it is drawn (see
   * bodyAt). The first entry's start is still the offset of its line break, after the lead. A body with no line
   * break at all reads as one paragraph with an empty ID, which validate() flags.
   */
  private readEntries(): Entry[] {
    const entries: Entry[] = [];
    const orphan: Run[] = [];
    let current: (Entry & { runs: Run[] }) | undefined;
    let offset = 0;
    const add = (run: Run) => (current ? current.runs : orphan).push(run);
    const finish = () => {
      if (!current) return;
      current.end = offset;
      current.paragraph.runs = normalizeRuns(current.runs);
      entries.push({ paragraph: current.paragraph, start: current.start, end: current.end, ...(current.untyped ? { untyped: true } : {}) });
    };
    for (const op of this.body.toDelta() as { insert?: unknown; attributes?: Attributes }[]) {
      if (typeof op.insert !== "string") continue;
      if (op.attributes?.soft) {
        add(toRun(op.insert, op.attributes));
        offset += op.insert.length;
        continue;
      }
      op.insert.split("\n").forEach((part, k) => {
        if (k > 0) {
          finish();
          current = newEntry(op.attributes ?? {}, offset);
          if (!entries.length) current.runs.push(...orphan);
          offset += 1;
        }
        if (part) add(toRun(part, op.attributes));
        offset += part.length;
      });
    }
    finish();
    if (!entries.length && orphan.length) entries.push({ paragraph: { id: "", type: "general", runs: normalizeRuns(orphan) }, start: 0, end: offset });
    return entries;
  }

  /**
   * Record an edit inside one paragraph in the cache: its new fields and runs, and how far the
   * paragraphs after it moved. Call inside the edit's transaction, right after the change.
   */
  private patch(index: number, paragraph: Paragraph, shift: number, typed = false): void {
    const cache = this.cache!;
    const entry = cache.entries[index]!;
    // The first paragraph's lead is in its runs but not between its start and end (see readEntries): read it again.
    if (index === 0 && entry.start > 0) return;
    cache.entries[index] = { paragraph, start: entry.start, end: entry.end + shift, ...(entry.untyped && !typed ? { untyped: true } : {}) };
    if (shift) {
      for (let i = index + 1; i < cache.entries.length; i++) {
        const next = cache.entries[i]!;
        next.start += shift;
        next.end += shift;
      }
    }
    cache.paragraphs = undefined;
    cache.clock = this.clock();
    cache.length = this.body.length;
    if (this.ydoc._transaction) this.patched.add(this.ydoc._transaction);
  }

  private locate(id: string): Entry & { index: number; entries: Entry[] } {
    const entries = this.entries();
    const index = this.cache!.ids.get(id);
    if (index === undefined) throw new RangeError(`No paragraph with ID ${id}.`);
    return { ...entries[index]!, index, entries };
  }

  /**
   * The paragraphs in order, read-only and shared: do not modify them. A paragraph keeps the same
   * object until it changes, so a view can compare lists by identity to find what to redraw.
   */
  paragraphs(): readonly Paragraph[] {
    const entries = this.entries();
    const cache = this.cache!;
    return (cache.paragraphs ??= entries.map((entry) => entry.paragraph));
  }

  /** The plain script, with Final Draft's revision and locked page elements written from the production state. */
  toScript(): Script {
    const fdx = fdxExtras(this);
    const template = this.meta.get("template");
    return projectScriptNotes(this, projectTags(this, {
      titlePage: structuredClone((this.meta.get("titlePage") as Script["titlePage"] | undefined) ?? []),
      paragraphs: this.entries().map((entry) => cloneParagraph(entry.paragraph)),
      ...(fdx ? { fdx: structuredClone(fdx) as Script["fdx"] } : {}),
      ...(isTemplateId(template) ? { template } : {}),
    }));
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  applyUpdate(update: Uint8Array, origin?: unknown): void {
    Y.applyUpdate(this.ydoc, update, origin);
  }

  scenes(): Scene[] {
    return scenesOf(this.entries().map((entry) => entry.paragraph));
  }

  indexOf(id: string): number {
    return this.locate(id).index;
  }

  has(id: string): boolean {
    this.entries();
    return this.cache!.ids.has(id);
  }

  paragraph(id: string): Paragraph {
    return cloneParagraph(this.locate(id).paragraph);
  }

  /**
   * Where a paragraph's text after its line break sits in the body: from start (just after the line break) up to
   * end. The first paragraph's lead (see readEntries) comes before this range; lead() says how long it is.
   */
  range(id: string): { start: number; end: number } {
    const { start, end } = this.locate(id);
    return { start: start + 1, end };
  }

  /**
   * How much text sits before the first line break (see readEntries). It is drawn, and counted in text offsets, as
   * the start of the first paragraph.
   */
  lead(): number {
    return this.entries()[0]?.start ?? 0;
  }

  /** Length of a paragraph's text as drawn: for the first paragraph, with its lead. */
  private textLength(entry: Entry, index: number): number {
    return entry.end - entry.start - 1 + (index === 0 ? entry.start : 0);
  }

  /**
   * The body offset of a text offset in a paragraph: just after its line break, plus the offset. In the first
   * paragraph, offsets inside its lead are body offsets as they are, and the rest skip the line break after it.
   */
  private bodyAt(entry: Entry, index: number, offset: number): number {
    const lead = index === 0 ? entry.start : 0;
    return offset < lead ? offset : entry.start + 1 + offset - lead;
  }

  /** The body ranges a text range covers: two in the first paragraph when it spans the line break after the lead. */
  private bodyRanges(entry: Entry, index: number, from: number, to: number): [number, number][] {
    const lead = index === 0 ? entry.start : 0;
    if (from >= lead || to <= lead) return [[this.bodyAt(entry, index, from), this.bodyAt(entry, index, to - 1) + 1]];
    return [[from, lead], [entry.start + 1, entry.start + 1 + to - lead]];
  }

  /**
   * Move the lead to just after the first line break, in the current transaction, so a change to the paragraph
   * structure there (a paragraph above, a split inside the lead, a deletion across the line break) works on plain
   * offsets. The text keeps its formatting and the line break keeps its ID; what is drawn does not change. Only
   * those local edits call it, never the repair: two peers moving the same text at once would each insert a copy.
   */
  private absorbLead(): void {
    const lead = this.lead();
    if (!lead) return;
    const runs: { insert: string; attributes: Attributes }[] = [];
    let taken = 0;
    for (const op of this.body.toDelta() as { insert?: unknown; attributes?: Attributes }[]) {
      if (taken >= lead) break;
      if (typeof op.insert !== "string") continue;
      // Soft line breaks in the lead are text, and stay soft.
      const part = op.insert.slice(0, lead - taken);
      runs.push({ insert: part, attributes: { ...(op.attributes ?? {}) } });
      taken += part.length;
    }
    this.ydoc.transact(() => {
      this.body.delete(0, lead);
      this.body.applyDelta([{ retain: 1 }, ...runs]);
    });
  }

  /** The body offset of a text position. With Y.RelativePosition this follows concurrent edits. */
  bodyIndex(at: TextPosition): number {
    const entry = this.locate(at.paragraphId);
    return this.bodyAt(entry, entry.index, Math.max(0, Math.min(at.offset, this.textLength(entry, entry.index))));
  }

  /** The text position at a body offset. An offset on a paragraph's line break reads as the end of the paragraph before it. */
  positionAt(index: number): TextPosition | null {
    const entries = this.entries();
    if (!entries.length) return null;
    let low = 0, high = entries.length - 1;
    // The last entry whose line break is before the index.
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (entries[mid]!.start < index) low = mid;
      else high = mid - 1;
    }
    const entry = entries[low]!;
    // The first paragraph's lead counts from the start of the body.
    const offset = low > 0 ? index - entry.start - 1 : index <= entry.start ? index : index - 1;
    return { paragraphId: entry.paragraph.id, offset: Math.max(0, Math.min(offset, this.textLength(entry, low))) };
  }

  /** Insert a paragraph at an index and return its ID. Scene headings get a scene ID equal to their own ID. */
  insertParagraph(index: number, init: Omit<Partial<Paragraph>, "runs"> & { type: ElementType; runs?: Run[] }): string {
    const paragraph: Paragraph = { ...init, id: init.id ?? newId(), runs: init.runs ?? [] };
    if (paragraph.type === "sceneHeading") paragraph.sceneId ??= paragraph.id;
    this.ydoc.transact(() => {
      // Above the first paragraph its lead stays with it, rather than becoming the new paragraph's text.
      if (index <= 0) this.absorbLead();
      const entries = this.entries();
      const at = index < entries.length ? entries[index]!.start : this.body.length;
      this.body.applyDelta([
        ...(at > 0 ? [{ retain: at }] : []),
        { insert: "\n", attributes: paragraphAttributes(paragraph) },
        ...normalizeRuns(paragraph.runs).flatMap((run) => textInserts(run.text, runAttributes(run))),
      ]);
    });
    return paragraph.id;
  }

  /**
   * Delete a paragraph from its line break to its end. The first paragraph's lead (see readEntries) stays and reads as
   * the start of the next paragraph: it is usually a co-writer's typing, and a program deleting this paragraph (Restore
   * Omitted Scene deleting the OMITTED line, say) has not seen it.
   */
  deleteParagraph(id: string): void {
    const { start, end } = this.locate(id);
    this.body.delete(start, end - start);
  }

  /** Change a paragraph's element type. The ID stays; a heading's scene ID is kept even if it is retyped and back. */
  setType(id: string, type: ElementType): void {
    const { start, paragraph, index } = this.locate(id);
    const change: Attributes = { type };
    if (type === "sceneHeading" && paragraph.sceneId === undefined) change.sceneId = id;
    this.ydoc.transact(() => {
      this.body.format(start, 1, change);
      this.patch(index, withAttributes(paragraph, change), 0, true);
    });
  }

  setField<K extends OptionalField>(id: string, field: K, value: Paragraph[K] | undefined): void {
    const { start, paragraph, index } = this.locate(id);
    const change = { [field]: value === undefined ? null : structuredClone(value) };
    this.ydoc.transact(() => {
      this.body.format(start, 1, change);
      this.patch(index, withAttributes(paragraph, change), 0);
    });
  }

  /** Insert text, continuing the formatting of the character before it unless marks say otherwise. */
  insertText(id: string, offset: number, text: string, marks: Marks = {}): void {
    const attributes: Attributes = {};
    if (offset > 0) {
      const [before] = cutRuns(this.locate(id).paragraph.runs, offset - 1, offset);
      if (before) Object.assign(attributes, runAttributes(before));
    }
    for (const [mark, on] of Object.entries(marks)) {
      if (on) attributes[mark] = true;
      else delete attributes[mark];
    }
    this.insertFormatted(id, offset, text, attributes);
  }

  /** Insert text with exactly these run attributes. */
  insertFormatted(id: string, offset: number, text: string, attributes: Attributes): void {
    const entry = this.locate(id);
    const { paragraph, index } = entry;
    if (offset < 0 || offset > this.textLength(entry, index)) throw new RangeError("Offset is outside the paragraph.");
    if (!text) return;
    const at = this.bodyAt(entry, index, offset);
    this.ydoc.transact(() => {
      this.body.applyDelta([...(at > 0 ? [{ retain: at }] : []), ...textInserts(text, attributes)]);
      const runs = normalizeRuns([...cutRuns(paragraph.runs, 0, offset), toRun(text, attributes), ...cutRuns(paragraph.runs, offset)]);
      this.patch(index, { ...paragraph, runs }, text.length);
    });
  }

  deleteText(id: string, offset: number, length: number): void {
    const entry = this.locate(id);
    const { paragraph, index } = entry;
    const size = this.textLength(entry, index);
    const at = Math.min(Math.max(0, offset), size);
    const count = Math.max(0, Math.min(length, size - at));
    if (!count) return;
    this.ydoc.transact(() => {
      for (const [from, to] of this.bodyRanges(entry, index, at, at + count).reverse()) this.body.delete(from, to - from);
      const runs = normalizeRuns([...cutRuns(paragraph.runs, 0, at), ...cutRuns(paragraph.runs, at + count)]);
      this.patch(index, { ...paragraph, runs }, -count);
    });
  }

  /**
   * Replace text inside one paragraph. The new text keeps the formatting of the text it replaces (its first
   * character), so a corrected word stays bold or italic, also at the start of the paragraph. Replacing nothing
   * is an insert, which continues the text before it.
   */
  replaceText(id: string, from: number, to: number, text: string): void {
    const { paragraph } = this.locate(id);
    const length = plainText(paragraph.runs).length;
    const a = Math.max(0, Math.min(from, length)), b = Math.max(a, Math.min(to, length));
    if (b === a) return this.insertText(id, a, text);
    const [first] = cutRuns(paragraph.runs, a, a + 1);
    this.ydoc.transact(() => {
      this.deleteText(id, a, b - a);
      this.insertFormatted(id, a, text, first ? runAttributes(first) : {});
    });
  }

  /** Set or clear marks on a range of one paragraph. Pass false to clear a mark. */
  format(id: string, offset: number, length: number, marks: Marks): void {
    this.formatRuns(id, offset, length, Object.fromEntries(Object.entries(marks).map(([mark, on]) => [mark, on ? true : null])));
  }

  /**
   * Set or clear (null) run attributes on a range of one paragraph: a mark, "styleExtra", "note", or an FDX
   * attribute as "fdx:<name>" (fdx:RevisionID marks revised text). The paragraph list is patched, not re-read.
   */
  formatRuns(id: string, offset: number, length: number, attributes: Record<string, string | true | null>): void {
    const entry = this.locate(id);
    const { paragraph, index } = entry;
    const size = this.textLength(entry, index);
    const at = Math.min(Math.max(0, offset), size);
    const count = Math.max(0, Math.min(length, size - at));
    if (!count) return;
    const change = (run: Run) => toRun(run.text, { ...runAttributes(run), ...attributes });
    this.ydoc.transact(() => {
      for (const [from, to] of this.bodyRanges(entry, index, at, at + count)) this.body.format(from, to - from, attributes);
      const runs = normalizeRuns([...cutRuns(paragraph.runs, 0, at), ...cutRuns(paragraph.runs, at, at + count).map(change), ...cutRuns(paragraph.runs, at + count)]);
      this.patch(index, { ...paragraph, runs }, 0);
    });
  }

  /**
   * Split a paragraph at a text offset (the Return key). The text before the offset keeps the paragraph
   * and its ID; the rest becomes a new paragraph, whose ID is returned. At offset 0 an empty paragraph
   * is inserted above instead, so the existing text keeps its ID.
   */
  splitParagraph(id: string, offset: number, type?: ElementType): string {
    const entry = this.locate(id);
    const { start, end, index, paragraph } = entry;
    // At or inside the first paragraph's lead, the lead joins the text after the line break first, so the split
    // falls where it is drawn and the text before it keeps the line break.
    if (index === 0 && start > 0 && offset <= start) {
      return this.ydoc.transact(() => {
        this.absorbLead();
        return this.splitParagraph(id, offset, type);
      });
    }
    const dual = paragraph.dual ? { dual: paragraph.dual } : {};
    if (offset === 0 && end > start + 1) return this.insertParagraph(index, { type: type ?? paragraph.type, ...dual });
    const created = newId();
    const attributes: Attributes = { id: created, type: type ?? paragraph.type, ...structuredClone(dual) };
    if (attributes.type === "sceneHeading") attributes.sceneId = created;
    this.body.insert(Math.min(this.bodyAt(entry, index, Math.max(0, offset)), end), "\n", attributes);
    return created;
  }

  /**
   * Join a paragraph onto the one before it (Backspace at the start). The earlier paragraph keeps its ID
   * and type, unless it is empty, in which case it is removed and this paragraph keeps its own.
   * Returns the ID that remains. Only a line break is deleted, so concurrent edits survive.
   */
  mergeWithPrevious(id: string): string {
    const { index, entries, start } = this.locate(id);
    if (index === 0) return id;
    const previous = entries[index - 1]!;
    // Empty: no text after its line break, nor (the first paragraph) a lead before it.
    if (previous.end === previous.start + 1 && !(index === 1 && previous.start > 0)) {
      this.body.delete(previous.start, 1);
      return id;
    }
    this.body.delete(start, 1);
    return previous.paragraph.id;
  }

  /**
   * Delete everything from one text position to another, across paragraphs (a selection deleted with
   * Backspace, cut, or typing over it). The paragraph at `from` keeps its ID and type and takes the
   * text after `to`; the paragraphs in between go. Only characters and line breaks are deleted, so a
   * co-writer's concurrent typing outside the range survives, and typing inside it is kept.
   */
  deleteRange(from: TextPosition, to: TextPosition): void {
    let a = this.bodyIndex(from), b = this.bodyIndex(to);
    if (b < a) [a, b] = [b, a];
    const lead = this.lead();
    // A range that ends at the end of the first paragraph's lead stops before the line break after it.
    if (lead && b === lead + 1) b = lead;
    // From the lead across that line break: the lead moves after the line break first, so the line break, which
    // holds the paragraph's ID and type, is not deleted.
    if (lead && a < lead && b > lead) {
      this.ydoc.transact(() => {
        this.absorbLead();
        this.deleteRange(from, to);
      });
      return;
    }
    if (b > a) this.body.delete(a, b - a);
  }

  /**
   * Insert whole paragraphs at a caret (paste). In the middle of a paragraph it is split first and the
   * new paragraphs go between the halves; at its start they go above it and at its end below. An empty
   * paragraph is replaced by the first new one, keeping its own ID. The copies get new paragraph, scene
   * and dual-dialogue IDs and lose scene numbers, so pasting twice never repeats an ID. Returns the IDs
   * of the paragraphs holding the inserted text, in order.
   */
  insertParagraphsAt(at: TextPosition, paragraphs: readonly Paragraph[]): string[] {
    if (!paragraphs.length) return [];
    const blocks = new Map<string, string>();
    const copies = paragraphs.map((paragraph) => freshCopy(paragraph, blocks));
    const ids: string[] = [];
    this.ydoc.transact(() => {
      if (this.indexOf(at.paragraphId) === 0) this.absorbLead();
      const { start, end, paragraph } = this.locate(at.paragraphId);
      const length = end - start - 1;
      const offset = Math.max(0, Math.min(at.offset, length));
      let point: number;
      if (length === 0) {
        const first = copies.shift()!;
        const change: Attributes = { type: first.type };
        for (const field of OPTIONAL_FIELDS) change[field] = first[field] === undefined ? null : structuredClone(first[field]);
        change.sceneId = first.type === "sceneHeading" ? (paragraph.sceneId ?? paragraph.id) : null;
        this.body.format(start, 1, change);
        // Clearing fields can delete formatting only, which the cache's stamp does not see.
        if (this.cache) this.cache.clock = -1;
        const runs = normalizeRuns(first.runs);
        if (runs.length) this.body.applyDelta([{ retain: start + 1 }, ...runs.flatMap((run) => textInserts(run.text, runAttributes(run)))]);
        ids.push(paragraph.id);
        point = start + 1 + plainText(runs).length;
      } else if (offset === 0) point = start;
      else if (offset === length) point = end;
      else {
        this.splitParagraph(paragraph.id, offset);
        point = start + 1 + offset;
      }
      if (!copies.length) return;
      this.body.applyDelta([
        ...(point > 0 ? [{ retain: point }] : []),
        ...copies.flatMap((copy) => [
          { insert: "\n", attributes: paragraphAttributes(copy) },
          ...normalizeRuns(copy.runs).flatMap((run) => textInserts(run.text, runAttributes(run))),
        ]),
      ]);
      ids.push(...copies.map((copy) => copy.id));
    });
    return ids;
  }

  /** Hear about each ID repair this copy makes, to tell the writer that a scene or paragraph is now there twice. */
  onRepair(listener: (report: RepairReport) => void): () => void {
    this.repairListeners.add(listener);
    return () => this.repairListeners.delete(listener);
  }

  /**
   * Give every later copy of a paragraph ID, every line break without an ID and every heading repeating a scene ID a
   * new ID made from its line break's Yjs character ID (see the top of this file). Nothing is deleted. Runs by itself
   * after transactions that can repeat or drop an ID; returns how many paragraphs changed.
   */
  repairDuplicates(): number {
    const report: RepairReport = { copies: [], headings: [], missing: 0 };
    let changed = 0;
    // An ID made from a line break can already be on another paragraph, carried there by a move of an earlier
    // repaired copy; that paragraph gives it up on the next pass (keeperOf). Made IDs never repeat otherwise.
    for (let pass = 0; pass < 4; pass++) {
      const entries = this.entries();
      if (!this.cache!.repeats) break;
      const changes = this.idChanges(entries, report);
      if (!changes.length) break;
      this.ydoc.transact(() => {
        for (const { start, attributes } of changes) this.body.format(start, 1, attributes);
      }, REPAIR_ORIGIN);
      changed += changes.length;
    }
    if (changed) for (const listener of this.repairListeners) listener(report);
    return changed;
  }

  private idChanges(entries: readonly Entry[], report: RepairReport): { start: number; attributes: Attributes }[] {
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const list = groups.get(entry.paragraph.id);
      if (list) list.push(entry);
      else groups.set(entry.paragraph.id, [entry]);
    }
    const renamed = new Set<Entry>();
    for (const [id, list] of groups) {
      if (!id) list.forEach((entry) => renamed.add(entry));
      else if (list.length > 1) for (const entry of list) renamed.add(entry);
    }
    const scenes = new Map<string, Entry[]>();
    for (const entry of entries) {
      const { type, sceneId } = entry.paragraph;
      if (type !== "sceneHeading" || sceneId === undefined) continue;
      const list = scenes.get(sceneId);
      if (list) list.push(entry);
      else scenes.set(sceneId, [entry]);
    }
    for (const list of scenes.values()) if (list.length > 1) for (const entry of list) renamed.add(entry);
    // The characters of every line break involved, in one walk of the text.
    const made = this.lineBreakIds([...renamed].map((entry) => entry.start));
    const keeperOf = (list: Entry[], id: string) => list.find((entry) => made.get(entry.start) === id) ?? list[0]!;
    const nextIds = new Map<Entry, string>();
    for (const [id, list] of groups) {
      if (id && list.length < 2) continue;
      const keeper = id ? keeperOf(list, id) : undefined;
      for (const entry of list) {
        const fresh = made.get(entry.start);
        if (entry !== keeper && fresh && fresh !== id) nextIds.set(entry, fresh);
      }
    }
    // A heading with a new ID takes it as its scene ID. Of the other headings sharing a scene ID, the one whose
    // paragraph ID it is keeps it (or the first), and the rest take their own paragraph ID.
    const nextScenes = new Map<Entry, string>();
    for (const [sceneId, list] of scenes) {
      const staying = list.filter((entry) => !nextIds.has(entry));
      if (list.length < 2 || staying.length < 2) continue;
      const keeper = staying.find((entry) => entry.paragraph.id === sceneId) ?? staying[0]!;
      for (const entry of staying) {
        const own = entry.paragraph.id && entry.paragraph.id !== sceneId ? entry.paragraph.id : made.get(entry.start);
        if (entry !== keeper && own) nextScenes.set(entry, own);
      }
    }
    // A paragraph that lost its type takes it from another copy of itself, or from its structure (see the top of
    // this file). Every peer reads the same text, so every peer sets the same type.
    const types = new Map<Entry, ElementType>();
    for (const entry of entries) {
      if (!entry.untyped) continue;
      const { id, sceneId } = entry.paragraph;
      const copy = (id && groups.get(id)?.find((other) => !other.untyped)) || (sceneId !== undefined && scenes.get(sceneId)?.find((other) => !other.untyped)) || undefined;
      const type = copy ? copy.paragraph.type : structuralType(entry.paragraph);
      if (type) types.set(entry, type);
    }
    const changes: { start: number; attributes: Attributes }[] = [];
    for (const entry of entries) {
      const { paragraph } = entry;
      const attributes: Attributes = {};
      const type = types.get(entry);
      if (type) {
        attributes.type = type;
        report.types = (report.types ?? 0) + 1;
      }
      const id = nextIds.get(entry);
      if (id !== undefined) {
        attributes.id = id;
        const heading = (type ?? paragraph.type) === "sceneHeading";
        if (heading || (paragraph.sceneId !== undefined && paragraph.sceneId === paragraph.id)) attributes.sceneId = id;
        if (paragraph.id) {
          report.copies.push(id);
          if (heading) report.headings.push(plainText(paragraph.runs));
        } else report.missing++;
      }
      const sceneId = nextScenes.get(entry);
      if (sceneId !== undefined) attributes.sceneId = sceneId;
      if (Object.keys(attributes).length) changes.push({ start: entry.start, attributes });
    }
    return changes;
  }

  /** The ID made from the line break character at each of these body offsets; offsets that hold no line break are left out. */
  private lineBreakIds(starts: number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (!starts.length) return out;
    const wanted = [...new Set(starts)].sort((a, b) => a - b);
    let next = 0;
    let index = 0;
    for (let item = this.body._start; item && next < wanted.length; item = item.right) {
      if (item.deleted || !item.countable) continue;
      const end = index + item.length;
      while (next < wanted.length && wanted[next]! < end) {
        const at = wanted[next++]!;
        if (item.content instanceof Y.ContentString && item.content.str[at - index] === "\n") out.set(at, idFromItem(item.id.client, item.id.clock + at - index));
      }
      index = end;
    }
    return out;
  }

  /** Problems that would break ID-based links: missing or duplicate paragraph IDs and duplicate scene IDs. */
  validate(): string[] {
    const problems: string[] = [];
    const ids = new Set<string>();
    const scenes = new Set<string>();
    this.entries().forEach(({ paragraph }, index) => {
      const id = paragraph.id;
      if (!id) problems.push(`Paragraph ${index + 1} has no ID.`);
      else if (ids.has(id)) problems.push(`Paragraph ${index + 1} repeats ID ${id}.`);
      else ids.add(id);
      if (paragraph.type === "sceneHeading" && paragraph.sceneId !== undefined) {
        if (scenes.has(paragraph.sceneId)) problems.push(`Paragraph ${index + 1} repeats scene ID ${paragraph.sceneId}.`);
        scenes.add(paragraph.sceneId);
      }
    });
    return problems;
  }
}
