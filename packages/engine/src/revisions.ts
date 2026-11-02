// Production revisions: colored revision sets, revision marks on changed text, locked pages and omitted scenes.
//
// How Final Draft stores them (measured on 1,183 real FDX files, element and attribute names only):
// - <Revisions ActiveSet RevisionMode="Yes|No" RevisionsShown Location="7.75" ShowPageColor ...> holds one
//   <Revision ID Name Mark="*" Color PageColor Style FullRevision/> per set. IDs run 1, 2, 3...; set 1 is Blue
//   (the original pages are White and carry no revision). Names are like "Blue Rev. (mm/dd/yy)".
// - Revised text is a Text element with RevisionID="<set ID>"; unrevised text has RevisionID="0" or none.
// - <DeletedText> right after Revisions lists <DeletedTextLocation Offset RevisionID/>, where text was deleted.
// - <LockedPages> lists <LockedPage PageNumber Position LockLevel LevelIndex Deleted/>. Position counts every
//   paragraph's text plus one break per paragraph (see fdxPositions in fdx.ts).
// - An omitted scene is a heading whose text is "OMITTED", keeping its Number, with the scene's paragraphs inside
//   an <OmittedScene> element after its Text.
// - There is no scene number lock in FDX; the app keeps it in the document meta (structure.ts) and writes it to
//   Final Draft's SceneNumberOptions element as Inklot... attributes, which Final Draft ignores and keeps.
//
// In the app the revision state lives in the document meta under "revisions" and locked pages under "pageLocks"
// (with "pageLockMove:" keys for page starts that Undo brought back, see reanchorPageLocks).
// toScript() writes Final Draft's Revisions and LockedPages elements from them (fdxExtras), so FDX export carries
// them. A script that came from Final Draft and was never changed here reads them from those elements. Locks made
// here are anchored to each page's first character (a Yjs relative position), so a page that starts inside a
// paragraph keeps starting with the same text however the text before it changes.
//
// Final Draft's behaviour, as far as it can be determined, and what the app does: in Revision Mode, typed or
// pasted text takes the current set's RevisionID; deleting text leaves a deletion mark where the text was, so its
// line gets a mark in the margin even though no revised text remains. A printed line with revised text or a
// deletion mark gets the set's mark character at Location (7.75"), and a page with any of them is a revised page:
// it is headed with the latest set's name and date and may print on that set's paper color.
import * as Y from "yjs";

import type { ScreenplayDoc } from "./doc.ts";
import { DELETION_NODE, LOCK_OFFSET_ATTR, LOCK_PARAGRAPH_ATTR, OMITTED_NATIVE_ATTR, fdxPositionAt, paragraphsFromFdxNodes } from "./fdx.ts";
import { newId } from "./ids.ts";
import type { FdxDocumentExtras, Paragraph, Run, Script, XmlNode } from "./model.ts";
import type { PageLock, Pagination } from "./pagination.ts";
import { sceneBlocks, sceneNumberLockFromFdx, sceneNumbersLocked, lockedSceneNumbersOf, writeSceneNumberLock } from "./structure.ts";

export interface RevisionSet {
  /** Final Draft's revision ID: "1", "2"... Text carries it as its RevisionID. */
  id: string;
  name: string;
  /** Paper color, "#RRGGBB". */
  color: string;
  /** The mark printed in the right margin of revised lines. */
  mark: string;
  /** Printed after the name in the page header, as written ("10/30/26"). */
  date: string;
  /** Final Draft's text style for revised text ("" for none). */
  style: string;
  /** Final Draft's color for revised text on screen, "#RRGGBB". */
  textColor?: string;
  /** Other attributes of Final Draft's Revision element, kept for export. */
  fdx?: [string, string][];
}

export interface RevisionState {
  sets: RevisionSet[];
  currentSetId: string | null;
  /** Revision Mode: changes are marked with the current set. */
  tracking: boolean;
  /** Draw revision marks in the editor. */
  showMarks: boolean;
  /** Other attributes of Final Draft's Revisions element (Location, RevisionsShown, ShowPageColor). */
  fdx?: [string, string][];
}

export const NO_REVISIONS: RevisionState = { sets: [], currentSetId: null, tracking: false, showMarks: true };

/** The standard (WGA) order of revision colors. White is the original draft. */
export const REVISION_COLORS: readonly { name: string; value: string }[] = [
  { name: "White", value: "#FFFFFF" },
  { name: "Blue", value: "#C6EDFE" },
  { name: "Pink", value: "#FDCCD4" },
  { name: "Yellow", value: "#FDFFAB" },
  { name: "Green", value: "#D1FED0" },
  { name: "Goldenrod", value: "#FACD39" },
  { name: "Buff", value: "#FCED9D" },
  { name: "Salmon", value: "#F8AE8E" },
  { name: "Cherry", value: "#FBA4B4" },
];

const ROUNDS = ["", "Second", "Third", "Fourth", "Fifth", "Sixth"];

/**
 * The color at a place in the revision order: 0 White, 1 Blue ... 8 Cherry, then Second Blue, Second Pink and so
 * on to Second Cherry, then Third Blue.
 */
export function revisionColor(index: number): { name: string; value: string } {
  if (index <= 0) return REVISION_COLORS[0]!;
  const cycle = REVISION_COLORS.length - 1;
  const round = Math.floor((index - 1) / cycle);
  const color = REVISION_COLORS[1 + ((index - 1) % cycle)]!;
  const prefix = ROUNDS[round] ?? `${round + 1}th`;
  return { name: prefix ? `${prefix} ${color.name}` : color.name, value: color.value };
}

/** "Blue Rev. 10/30/26": what the header of a revised page shows. */
export function revisionLabel(set: Pick<RevisionSet, "name" | "date">): string {
  return [set.name.trim(), set.date.trim()].filter(Boolean).join(" ");
}

/** Today as Final Draft writes revision dates, "10/30/26". */
export function revisionDate(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getMonth() + 1)}/${two(date.getDate())}/${two(date.getFullYear() % 100)}`;
}

/** A new set after the existing ones: the next color in the order, named "Blue Rev." and dated today. */
export function newRevisionSet(state: RevisionState, init: Partial<Omit<RevisionSet, "id">> = {}): RevisionSet {
  const id = String(state.sets.reduce((max, set) => Math.max(max, Number.parseInt(set.id, 10) || 0), 0) + 1);
  const color = revisionColor(state.sets.length + 1);
  return { id, name: `${color.name} Rev.`, color: color.value, mark: "*", date: revisionDate(), style: "", ...init };
}

// ----- Final Draft XML -------------------------------------------------------------------------------------

const attrOf = (node: XmlNode, name: string) => node.attrs.find(([key]) => key === name)?.[1];
const childNodes = (node: XmlNode, name: string) => node.children.filter((child): child is XmlNode => typeof child !== "string" && child.name === name);

/** "#RRGGBB" from Final Draft's 16-bit "#RRRRGGGGBBBB" (or an 8-bit one). */
function fromFdxColor(value: string | undefined): string | undefined {
  const hex = /^#([0-9a-f]+)$/i.exec(value?.trim() ?? "")?.[1];
  if (hex?.length === 6) return `#${hex.toUpperCase()}`;
  if (hex?.length === 12) return `#${(hex.slice(0, 2) + hex.slice(4, 6) + hex.slice(8, 10)).toUpperCase()}`;
  return undefined;
}

function toFdxColor(value: string): string {
  return `#${value.slice(1).match(/../g)!.map((byte) => byte + byte).join("")}`.toUpperCase();
}

function topNode(extras: FdxDocumentExtras | undefined, name: string): XmlNode | undefined {
  return extras ? [...extras.before, ...extras.after].find((node) => node.name === name) : undefined;
}

const DATED_NAME = /^(.*?)\s*\((\d{1,2}\/\d{1,2}\/\d{2,4})\)\s*$/;
const SET_ATTRS = new Set(["ID", "Name", "Mark", "PageColor", "Color", "Style"]);
const STATE_ATTRS = new Set(["ActiveSet", "RevisionMode"]);

/** The revision state Final Draft wrote, or undefined when the file has no Revisions element. */
export function revisionsFromFdx(extras: FdxDocumentExtras | undefined): RevisionState | undefined {
  const node = topNode(extras, "Revisions");
  if (!node) return undefined;
  const sets = childNodes(node, "Revision").map((revision, index): RevisionSet => {
    const full = attrOf(revision, "Name") ?? "";
    const dated = DATED_NAME.exec(full);
    const textColor = fromFdxColor(attrOf(revision, "Color"));
    const extra = revision.attrs.filter(([name]) => !SET_ATTRS.has(name));
    return {
      id: attrOf(revision, "ID") ?? String(index + 1),
      name: dated ? dated[1]! : full,
      color: fromFdxColor(attrOf(revision, "PageColor")) ?? revisionColor(index + 1).value,
      mark: attrOf(revision, "Mark") ?? "*",
      date: dated ? dated[2]! : "",
      style: attrOf(revision, "Style") ?? "",
      ...(textColor ? { textColor } : {}),
      ...(extra.length ? { fdx: extra } : {}),
    };
  });
  const active = attrOf(node, "ActiveSet");
  const extra = node.attrs.filter(([name]) => !STATE_ATTRS.has(name));
  return {
    sets,
    currentSetId: sets.some((set) => set.id === active) ? active! : null,
    tracking: attrOf(node, "RevisionMode") === "Yes",
    showMarks: true,
    ...(extra.length ? { fdx: extra } : {}),
  };
}

const sorted = (attrs: [string, string][]) => attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Final Draft's Revisions element for a state, attributes in Final Draft's (alphabetical) order. */
export function revisionsNode(state: RevisionState): XmlNode {
  const own = new Map(state.fdx ?? []);
  if (!own.has("Location")) own.set("Location", "7.75");
  if (!own.has("RevisionsShown")) own.set("RevisionsShown", "All");
  if (!own.has("ShowPageColor")) own.set("ShowPageColor", "No");
  own.set("ActiveSet", state.currentSetId ?? "0");
  own.set("RevisionMode", state.tracking ? "Yes" : "No");
  return {
    name: "Revisions",
    attrs: sorted([...own]),
    children: state.sets.map((set) => {
      const attrs = new Map(set.fdx ?? []);
      if (!attrs.has("FullRevision")) attrs.set("FullRevision", "No");
      attrs.set("ID", set.id);
      attrs.set("Name", set.date.trim() ? `${set.name.trim()} (${set.date.trim()})` : set.name);
      attrs.set("Mark", set.mark || "*");
      attrs.set("PageColor", toFdxColor(set.color));
      attrs.set("Color", toFdxColor(set.textColor ?? "#000000"));
      attrs.set("Style", set.style);
      return { name: "Revision", attrs: sorted([...attrs]), children: [] };
    }),
  };
}

const DEFAULT_EXTRAS: FdxDocumentExtras = { rootAttrs: [["DocumentType", "Script"], ["Template", "No"], ["Version", "5"]], contentAttrs: [], before: [], after: [] };

/** Replace or add a top-level element of the FDX extras (which are a copy). */
function putFdxNode(extras: FdxDocumentExtras, node: XmlNode): void {
  for (const list of [extras.before, extras.after]) {
    const index = list.findIndex((n) => n.name === node.name);
    if (index < 0) continue;
    list[index] = node;
    return;
  }
  // Final Draft writes LockedPages, then Revisions, then DeletedText.
  const anchor = node.name === "LockedPages" ? extras.after.findIndex((n) => n.name === "Revisions") : -1;
  if (anchor >= 0) extras.after.splice(anchor, 0, node);
  else extras.after.push(node);
}

/** Final Draft's DeletedText element as Clear Revision Marks left it, kept apart from the "fdx" meta value. */
const DELETED_TEXT_KEY = "fdxDeletedText";

/**
 * The document's FDX extras with Final Draft's Revisions, LockedPages, DeletedText and SceneNumberOptions elements
 * written from the production state, as FDX export needs them (toScript() returns these). The production state keeps
 * its own meta keys and never writes the shared "fdx" value: a title page edit also writes that value, and a later
 * write to it from a production setting, which undo does not track, would leave the title page edit nothing to undo.
 */
export function fdxExtras(doc: ScreenplayDoc): FdxDocumentExtras | undefined {
  const raw = doc.meta.get("fdx") as FdxDocumentExtras | undefined;
  const revisions = doc.meta.get("revisions") as RevisionState | undefined;
  // Where locked pages start now, which writeFdx counts out as Final Draft positions.
  const locks = doc.meta.has("pageLocks") ? (pageLocks(doc) ?? []) : undefined;
  const deleted = doc.meta.get(DELETED_TEXT_KEY) as XmlNode | undefined;
  // The lock's own meta key wins over the file's, so Unlock Scene Numbers sticks.
  const sceneLock = doc.meta.has("sceneNumbersLocked") || sceneNumberLockFromFdx(raw) !== undefined;
  if (!revisions && !locks && !deleted && !sceneLock) return raw;
  const extras = structuredClone(raw ?? DEFAULT_EXTRAS);
  if (sceneLock) {
    const locked = sceneNumbersLocked(doc);
    writeSceneNumberLock(extras, locked, locked ? lockedSceneNumbersOf(doc) : undefined);
  }
  if (locks) putFdxNode(extras, lockedPagesNode(locks.map((lock) => locatedLock(doc, lock))));
  if (revisions) putFdxNode(extras, revisionsNode(revisions));
  if (deleted) putFdxNode(extras, deleted);
  return extras;
}

// ----- State -----------------------------------------------------------------------------------------------

const fdxCache = new WeakMap<object, RevisionState>();

/** The document's revision state: the meta's, else what Final Draft wrote, else none. */
export function revisionState(doc: ScreenplayDoc): RevisionState {
  const own = doc.meta.get("revisions") as RevisionState | undefined;
  if (own) return own;
  const extras = doc.meta.get("fdx") as FdxDocumentExtras | undefined;
  if (!extras) return NO_REVISIONS;
  let cached = fdxCache.get(extras);
  if (!cached) fdxCache.set(extras, (cached = revisionsFromFdx(extras) ?? NO_REVISIONS));
  return cached;
}

/** Store the revision state. FDX export writes Final Draft's copy of it (fdxExtras). */
export function setRevisionState(doc: ScreenplayDoc, state: RevisionState): void {
  doc.meta.set("revisions", structuredClone(state));
}

export function updateRevisionState(doc: ScreenplayDoc, change: (state: RevisionState) => Partial<RevisionState>): RevisionState {
  const current = revisionState(doc);
  const next = { ...current, ...change(current) };
  setRevisionState(doc, next);
  return next;
}

export function currentRevisionSet(state: RevisionState): RevisionSet | undefined {
  return state.sets.find((set) => set.id === state.currentSetId);
}

// ----- Marks -----------------------------------------------------------------------------------------------

const REVISION_ATTR = "fdx:RevisionID";

/** The revision a run belongs to, or undefined for unrevised text. */
export function runRevision(run: Pick<Run, "fdx">): string | undefined {
  const id = run.fdx?.RevisionID;
  return id && id !== "0" ? id : undefined;
}

/** Revised stretches of a paragraph's text: [from, to) offsets and the set. */
export function revisedRanges(paragraph: Paragraph): { from: number; to: number; setId: string }[] {
  const out: { from: number; to: number; setId: string }[] = [];
  let at = 0;
  for (const run of paragraph.runs) {
    const id = runRevision(run);
    if (id && !run.note) {
      const last = out.at(-1);
      if (last && last.setId === id && last.to === at) last.to = at + run.text.length;
      else out.push({ from: at, to: at + run.text.length, setId: id });
    }
    at += run.text.length;
  }
  return out;
}

/** Deletion marks on a paragraph: where text was deleted, and in which set. */
export function deletionMarks(paragraph: Paragraph): { offset: number; setId: string }[] {
  return (paragraph.fdx?.after ?? []).filter((node) => node.name === DELETION_NODE)
    .map((node) => ({ offset: Number.parseInt(attrOf(node, "Offset") ?? "0", 10) || 0, setId: attrOf(node, "RevisionID") ?? "0" }));
}

/** Deletion marks Final Draft wrote (its DeletedText element), placed on the paragraphs they now fall in. */
export function importedDeletionMarks(script: Pick<Script, "paragraphs" | "fdx">): Map<string, { offset: number; setId: string }[]> {
  const out = new Map<string, { offset: number; setId: string }[]>();
  const node = topNode(script.fdx, "DeletedText");
  if (!node) return out;
  for (const location of childNodes(node, "DeletedTextLocation")) {
    const at = fdxPositionAt(script.paragraphs, Number.parseInt(attrOf(location, "Offset") ?? "", 10));
    const setId = attrOf(location, "RevisionID");
    if (!at || !setId || setId === "0") continue;
    const list = out.get(at.paragraphId) ?? [];
    list.push({ offset: at.offset, setId });
    out.set(at.paragraphId, list);
  }
  return out;
}

/**
 * Mark text inserted at a body offset as revised in a set. Paragraph breaks in it are left alone (they hold the
 * paragraph's own fields); soft line breaks and text are marked.
 */
export function markInserted(doc: ScreenplayDoc, index: number, text: string, setId: string): void {
  doc.ydoc.transact(() => {
    let at = index;
    for (const part of text.split(/(\n)/)) {
      const position = part && part !== "\n" ? doc.positionAt(at) : null;
      // Through the document's own formatting, which patches its paragraph list instead of re-reading it.
      if (position) doc.formatRuns(position.paragraphId, position.offset, part.length, { [REVISION_ATTR]: setId });
      at += part.length;
    }
  });
}

/**
 * Record a deletion inside a paragraph. A paragraph keeps a mark for each place text was deleted, so each printed
 * line that lost text gets its margin mark; a second deletion at the same place adds nothing.
 */
export function addDeletionMark(doc: ScreenplayDoc, paragraphId: string, offset: number, setId: string): void {
  const paragraph = doc.paragraph(paragraphId);
  const after = paragraph.fdx?.after ?? [];
  if (after.some((node) => node.name === DELETION_NODE && attrOf(node, "RevisionID") === setId && attrOf(node, "Offset") === String(offset))) return;
  const node: XmlNode = { name: DELETION_NODE, attrs: [["Offset", String(offset)], ["RevisionID", setId]], children: [] };
  doc.setField(paragraphId, "fdx", { ...paragraph.fdx, after: [...after, node] });
}

/**
 * Keep a paragraph's deletion marks where their text is after an edit inside the paragraph: `length` characters
 * inserted at `offset`, or (negative) deleted from it. Marks after the edit move with the text; marks inside
 * deleted text close up to where it was, and two marks of a set that land together become one.
 */
export function adjustDeletionMarks(doc: ScreenplayDoc, paragraphId: string, offset: number, length: number): void {
  if (!length || !doc.has(paragraphId)) return;
  const paragraph = doc.paragraph(paragraphId);
  const after = paragraph.fdx?.after;
  if (!after?.some((node) => node.name === DELETION_NODE)) return;
  const seen = new Set<string>();
  let changed = false;
  const next: XmlNode[] = [];
  for (const node of after) {
    if (node.name !== DELETION_NODE) {
      next.push(node);
      continue;
    }
    const was = Number.parseInt(attrOf(node, "Offset") ?? "0", 10) || 0;
    const now = length > 0 ? (was > offset ? was + length : was) : was > offset - length ? was + length : Math.min(was, offset);
    const key = `${attrOf(node, "RevisionID")}@${now}`;
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    if (now === was) next.push(node);
    else {
      changed = true;
      next.push({ ...node, attrs: node.attrs.map(([name, value]): [string, string] => [name, name === "Offset" ? String(now) : value]) });
    }
  }
  if (changed) doc.setField(paragraphId, "fdx", { ...paragraph.fdx, after: next });
}

/**
 * Clear revision marks: of one set, or of every set when setId is null. Revised text becomes unrevised and
 * deletion marks go, including the ones Final Draft wrote. Returns how many marks were cleared.
 */
export function clearRevisionMarks(doc: ScreenplayDoc, setId: string | null): number {
  const matches = (id: string | undefined) => !!id && id !== "0" && (setId === null || id === setId);
  let cleared = 0;
  doc.ydoc.transact(() => {
    let at = 0;
    for (const op of doc.body.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
      const length = typeof op.insert === "string" ? op.insert.length : 1;
      const id = op.attributes?.[REVISION_ATTR];
      if (typeof id === "string" && matches(id)) {
        doc.body.format(at, length, { [REVISION_ATTR]: null });
        cleared++;
      }
      at += length;
    }
    for (const paragraph of doc.paragraphs()) {
      const after = paragraph.fdx?.after;
      if (!after?.some((node) => node.name === DELETION_NODE && matches(attrOf(node, "RevisionID")))) continue;
      const kept = after.filter((node) => !(node.name === DELETION_NODE && matches(attrOf(node, "RevisionID"))));
      cleared += after.length - kept.length;
      const fdx = { ...paragraph.fdx };
      if (kept.length) fdx.after = kept;
      else delete fdx.after;
      doc.setField(paragraph.id, "fdx", Object.keys(fdx).length ? fdx : undefined);
    }
    const deleted = (doc.meta.get(DELETED_TEXT_KEY) as XmlNode | undefined) ?? topNode(doc.meta.get("fdx") as FdxDocumentExtras | undefined, "DeletedText");
    if (deleted) {
      const kept = deleted.children.filter((child) => typeof child === "string" || !matches(attrOf(child, "RevisionID")));
      if (kept.length !== deleted.children.length) {
        cleared += deleted.children.length - kept.length;
        doc.meta.set(DELETED_TEXT_KEY, { ...deleted, children: kept });
      }
    }
  });
  return cleared;
}

// ----- Printed revisions -----------------------------------------------------------------------------------

export interface PageRevision {
  /** Indexes into the page's lines of the lines that get a revision mark. */
  marked: number[];
  /** The latest set with a mark on the page; undefined for an unrevised page. */
  set?: RevisionSet;
  /** The ID of that set, also when the set is not in the state (a file that lost its Revisions element). */
  setId?: string;
}

/**
 * Which printed lines carry revised text or a deletion mark, and the latest revision on each page. "Latest" is
 * the set's place in the state's list (sets are added in order). An A-page is new paper even when the text on it
 * only moved there, so one without revisions of its own takes the revision of the page before it.
 */
export function pageRevisions(script: Pick<Script, "paragraphs" | "fdx">, pagination: Pagination, state: RevisionState): PageRevision[] {
  const order = new Map(state.sets.map((set, index) => [set.id, index]));
  const rank = (id: string) => order.get(id) ?? (Number.parseInt(id, 10) || 0) - 1000;
  const deletions = importedDeletionMarks(script);
  for (const paragraph of script.paragraphs) {
    const own = deletionMarks(paragraph).filter((mark) => mark.setId !== "0");
    if (own.length) deletions.set(paragraph.id, [...(deletions.get(paragraph.id) ?? []), ...own]);
  }
  let previous: string | undefined;
  return pagination.pages.map((page) => {
    const marked: number[] = [];
    let latest: string | undefined = page.added ? previous : undefined;
    const note = (id: string) => {
      if (latest === undefined || rank(id) > rank(latest)) latest = id;
    };
    page.lines.forEach((line, index) => {
      if (line.generated) return;
      let hit = false;
      for (const run of line.runs) {
        const id = runRevision(run);
        if (id) {
          hit = true;
          note(id);
        }
      }
      for (const mark of deletions.get(line.paragraphId) ?? []) {
        if (mark.offset >= line.from && mark.offset <= line.to) {
          hit = true;
          note(mark.setId);
        }
      }
      if (hit) marked.push(index);
    });
    previous = latest;
    const set = latest !== undefined ? state.sets.find((candidate) => candidate.id === latest) : undefined;
    return { marked, ...(set ? { set } : {}), ...(latest !== undefined ? { setId: latest } : {}) };
  });
}

// ----- Locked pages ----------------------------------------------------------------------------------------

/** How many paragraphs of each locked page are remembered, to find the page again after deletions. */
const REMEMBERED = 8;

/**
 * A locked page as the document meta keeps it: where it started when it was locked, and an anchor on that first
 * character (a Yjs relative position, as JSON) so the page start follows its text through every later edit.
 */
export interface StoredPageLock extends PageLock {
  anchor?: unknown;
}

export interface PageLocks {
  pages: StoredPageLock[];
}

/** Locked pages as Final Draft wrote them, tied to paragraphs by parseFdx. Null when the file has none. */
export function locksFromFdx(script: Pick<Script, "paragraphs" | "fdx">): PageLock[] | null {
  const node = topNode(script.fdx, "LockedPages");
  const pages = node ? childNodes(node, "LockedPage") : [];
  if (!pages.length) return null;
  const index = new Map(script.paragraphs.map((paragraph, i) => [paragraph.id, i]));
  const starts = pages.map((page) => index.get(attrOf(page, LOCK_PARAGRAPH_ATTR) ?? "") ?? -1);
  const locks: PageLock[] = [];
  pages.forEach((page, k) => {
    const paragraphId = attrOf(page, LOCK_PARAGRAPH_ATTR);
    if (paragraphId === undefined || starts[k]! < 0) return;
    const end = starts.slice(k + 1).find((start) => start >= 0) ?? script.paragraphs.length;
    const following = script.paragraphs.slice(starts[k]! + 1, Math.min(end, starts[k]! + REMEMBERED)).map((paragraph) => paragraph.id);
    const level = Number.parseInt(attrOf(page, "LockLevel") ?? "0", 10) || 0;
    locks.push({
      number: attrOf(page, "PageNumber") ?? String(k + 1), paragraphId,
      offset: Number.parseInt(attrOf(page, LOCK_OFFSET_ATTR) ?? "0", 10) || 0, paragraphIds: following, level,
    });
  });
  return locks.length ? locks : null;
}

/** A Yjs relative position on the character at a text position, as plain JSON for the meta. */
function anchorAt(doc: ScreenplayDoc, paragraphId: string, offset: number): unknown {
  if (!doc.has(paragraphId)) return undefined;
  const position = Y.createRelativePositionFromTypeIndex(doc.body, doc.bodyIndex({ paragraphId, offset }));
  return JSON.parse(JSON.stringify(Y.relativePositionToJSON(position)));
}

/**
 * Meta keys that say what Undo made of a locked page's first character: "pageLockMove:<client>:<clock>" holds the
 * ID of the character Undo brought back in its place. reanchorPageLocks writes each one once, on the replica that
 * ran the Undo, and nothing changes it. Each has a key of its own, so it never stands in the way of undoing a
 * change to "pageLocks" (Lock Pages, Unlock Pages).
 */
const ANCHOR_MOVE = "pageLockMove:";
const moveKey = (id: Y.ID) => `${ANCHOR_MOVE}${id.client}:${id.clock}`;

/** How many anchor moves the document has; they are only ever added. */
function anchorMoves(doc: ScreenplayDoc): number {
  let count = 0;
  for (const key of doc.meta.keys()) if (key.startsWith(ANCHOR_MOVE)) count++;
  return count;
}

/** An anchor as the character it stands for now: through every move Undo made of it (see ANCHOR_MOVE). */
function movedAnchor(doc: ScreenplayDoc, position: Y.RelativePosition): Y.RelativePosition {
  let id = position.item;
  for (let guard = 0; id && guard < 1000; guard++) {
    const next = doc.meta.get(moveKey(id)) as { client?: unknown; clock?: unknown } | undefined;
    if (typeof next?.client !== "number" || typeof next.clock !== "number") break;
    id = Y.createID(next.client, next.clock);
  }
  if (!id || id === position.item) return position;
  return Y.createRelativePositionFromJSON({ ...(Y.relativePositionToJSON(position) as object), item: { client: id.client, clock: id.clock } });
}

/**
 * The anchored character still exists. Only the shared document state counts: never Yjs's record of what this
 * replica's Undo brought back (Item.redone), which is not synced, so co-writers with the same document would
 * read different page starts from it. reanchorPageLocks records where Undo brought it back, for everyone.
 */
function anchorAlive(doc: ScreenplayDoc, position: Y.RelativePosition): boolean {
  const id = position.item;
  if (!id) return true;
  if (Y.getState(doc.ydoc.store, id.client) <= id.clock) return false;
  const item = Y.getItem(doc.ydoc.store, id);
  return item instanceof Y.Item && !item.deleted;
}

/** A stored anchor as a relative position, or undefined when it is not one. */
function anchorPosition(anchor: unknown): Y.RelativePosition | undefined {
  if (anchor === undefined) return undefined;
  try {
    return Y.createRelativePositionFromJSON(anchor);
  } catch {
    return undefined;
  }
}

/**
 * Where a stored lock's page starts now. A page that started with a whole paragraph keeps to that paragraph while
 * it exists. One that started inside a paragraph keeps to the character it started with, through insertions and
 * deletions before it, splits and joins. When that character was deleted the page starts where it was, unless
 * its paragraph still exists elsewhere (a moved scene is deleted and inserted again with the same IDs). This
 * reads the shared document only, so every replica with the same state finds the same start.
 */
function resolveLock(doc: ScreenplayDoc, lock: StoredPageLock): PageLock {
  const { anchor, ...plain } = lock;
  if (anchor === undefined || (lock.offset === 0 && doc.has(lock.paragraphId))) return plain;
  const stored = anchorPosition(anchor);
  if (!stored) return plain;
  const position = movedAnchor(doc, stored);
  // Not through undone deletions: Item.redone exists only on the replica that ran the Undo.
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, doc.ydoc, false);
  const at = absolute && absolute.type === doc.body ? doc.positionAt(absolute.index) : null;
  if (!at) return plain;
  if (at.paragraphId !== lock.paragraphId && doc.has(lock.paragraphId) && !anchorAlive(doc, position)) return plain;
  return at.paragraphId === lock.paragraphId && at.offset === lock.offset ? plain : { ...plain, paragraphId: at.paragraphId, offset: at.offset };
}

const resolved = new WeakMap<object, { paragraphs: readonly Paragraph[]; moves: number; locks: PageLock[] }>();

/** The document's locked pages where they start now, or null when pages are not locked. */
export function pageLocks(doc: ScreenplayDoc): PageLock[] | null {
  if (!doc.meta.has("pageLocks")) {
    return locksFromFdx({ paragraphs: doc.paragraphs() as Paragraph[], fdx: doc.meta.get("fdx") as FdxDocumentExtras | undefined });
  }
  const stored = doc.meta.get("pageLocks") as PageLocks | null;
  if (!stored) return null;
  // Read once per document version: the editor, the status bar and the menus all ask.
  const paragraphs = doc.paragraphs(), moves = anchorMoves(doc);
  const cached = resolved.get(stored);
  if (cached?.paragraphs === paragraphs && cached.moves === moves) return cached.locks;
  const locks = stored.pages.map((lock) => resolveLock(doc, lock));
  resolved.set(stored, { paragraphs, moves, locks });
  return locks;
}

/**
 * Locks for the pages of a pagination: where each page starts and the paragraphs on it. When pages were locked
 * before, pages keep their lock level and pages locked for the first time get the next level.
 */
export function locksFromPagination(pagination: Pagination, previous: readonly PageLock[] | null = null): PageLock[] {
  const levels = new Map((previous ?? []).map((lock) => [lock.number, lock.level ?? 0]));
  const nextLevel = previous?.length ? Math.max(...previous.map((lock) => lock.level ?? 0)) + 1 : 0;
  const locks: PageLock[] = [];
  for (const page of pagination.pages) {
    const lines = page.lines.filter((line) => !line.generated && line.paragraphId);
    const first = lines[0];
    if (!first) continue;
    const ids = [...new Set(lines.map((line) => line.paragraphId))];
    locks.push({
      number: page.number, paragraphId: first.paragraphId, offset: first.from,
      paragraphIds: ids.slice(1, REMEMBERED), level: levels.get(page.number) ?? nextLevel,
    });
  }
  return locks;
}

/**
 * A lock whose first paragraph is gone starts where pagination finds it: at the first of the paragraphs it
 * remembers that is still there.
 */
function locatedLock(doc: ScreenplayDoc, lock: PageLock): PageLock {
  if (doc.has(lock.paragraphId)) return lock;
  const found = (lock.paragraphIds ?? []).find((id) => doc.has(id));
  return found === undefined ? lock : { ...lock, paragraphId: found, offset: 0 };
}

/** Final Draft's LockedPages element. Positions are tied to paragraphs; writeFdx counts them out. */
function lockedPagesNode(locks: readonly PageLock[]): XmlNode {
  return {
    name: "LockedPages", attrs: [],
    children: locks.map((lock, index): XmlNode => ({
      name: "LockedPage",
      attrs: [
        ["Deleted", "0"], ["LevelIndex", String(index)], ["LockLevel", String(lock.level ?? 0)], ["PageNumber", lock.number],
        ["Position", "0"], [LOCK_PARAGRAPH_ATTR, lock.paragraphId], [LOCK_OFFSET_ATTR, String(lock.offset)],
      ],
      children: [],
    })),
  };
}

/**
 * Lock Pages: keep today's page breaks (from the pagination of the document as it is now). Relocking keeps
 * A-page numbers. Each page is anchored to its first character, so it keeps starting there through edits.
 */
export function lockPages(doc: ScreenplayDoc, pagination: Pagination): PageLock[] {
  const locks = locksFromPagination(pagination, pageLocks(doc));
  const pages = locks.map((lock): StoredPageLock => {
    const anchor = anchorAt(doc, lock.paragraphId, lock.offset);
    return anchor === undefined ? lock : { ...lock, anchor };
  });
  doc.meta.set("pageLocks", { pages } satisfies PageLocks);
  return locks;
}

const midParagraph = new WeakMap<object, boolean>();

/**
 * The document's locked pages come from its FDX file and some start inside a paragraph (pages this app locked
 * and saved to FDX; Final Draft's own start at paragraph starts). Those need anchoring to follow their text.
 */
export function fdxLocksNeedAnchors(doc: ScreenplayDoc): boolean {
  if (doc.meta.has("pageLocks")) return false;
  const extras = doc.meta.get("fdx") as FdxDocumentExtras | undefined;
  if (!extras) return false;
  let found = midParagraph.get(extras);
  if (found === undefined) {
    const pages = childNodes(topNode(extras, "LockedPages") ?? { name: "", attrs: [], children: [] }, "LockedPage");
    found = pages.some((page) => (Number.parseInt(attrOf(page, LOCK_OFFSET_ATTR) ?? "0", 10) || 0) > 0);
    midParagraph.set(extras, found);
  }
  return found;
}

/**
 * Anchor the locked pages an FDX file brought to their first characters, as Lock Pages anchors its own, during
 * the first edit: `before` is the script before that edit, `index` maps a body offset from before it to after
 * it, and `deleted` says whether the edit deleted the character at a body offset from before it. Returns false
 * when there was nothing to anchor.
 */
export function anchorFdxLocks(
  doc: ScreenplayDoc, before: readonly Paragraph[], index: (offset: number) => number, deleted: (offset: number) => boolean = () => false,
): boolean {
  if (!fdxLocksNeedAnchors(doc)) return false;
  const locks = locksFromFdx({ paragraphs: before as Paragraph[], fdx: doc.meta.get("fdx") as FdxDocumentExtras | undefined });
  if (!locks) return false;
  const starts = new Map<string, number>();
  let at = 0;
  for (const paragraph of before) {
    if (!starts.has(paragraph.id)) starts.set(paragraph.id, at);
    at += 1 + paragraph.runs.reduce((sum, run) => sum + run.text.length, 0);
  }
  const pages = locks.map((lock): StoredPageLock => {
    const start = starts.get(lock.paragraphId);
    if (!lock.offset || start === undefined) return lock;
    let at = index(start + 1 + lock.offset);
    // The edit deleted the page's first character, and its paragraph is still there but elsewhere: a moved scene,
    // which is deleted and inserted again with the same IDs and text. The page starts in the moved text, not where
    // it used to be. (Return or a paste before the character moves it into a new paragraph; that is not this.)
    if (deleted(start + 1 + lock.offset) && doc.has(lock.paragraphId) && doc.positionAt(at)?.paragraphId !== lock.paragraphId) {
      at = doc.bodyIndex({ paragraphId: lock.paragraphId, offset: lock.offset });
    }
    const position = Y.createRelativePositionFromTypeIndex(doc.body, at);
    return { ...lock, anchor: JSON.parse(JSON.stringify(Y.relativePositionToJSON(position))) };
  });
  doc.meta.set("pageLocks", { pages } satisfies PageLocks);
  return true;
}

/**
 * After an Undo or Redo on this replica: a locked page anchored to a character that the undone edit deleted
 * starts with that character again once Undo brings it back. Yjs restores deleted text as new characters and
 * links them to the old ones only on the replica that undid (Item.redone, never synced), so this records each such
 * link for a page's first character in the shared meta (see ANCHOR_MOVE), where every co-writer reads it. The
 * locks themselves are not rewritten, so Undo can still take back Lock Pages. Run it in a transaction that undo
 * does not track. Returns whether an anchor moved.
 */
export function reanchorPageLocks(doc: ScreenplayDoc): boolean {
  const stored = doc.meta.get("pageLocks") as PageLocks | null | undefined;
  if (!stored?.pages.some((page) => page.anchor !== undefined)) return false;
  const store = doc.ydoc.store;
  let moved = false;
  for (const page of stored.pages) {
    const position = anchorPosition(page.anchor);
    const from = position && movedAnchor(doc, position).item;
    if (!from || Y.getState(store, from.client) <= from.clock) continue;
    const first = Y.getItem(store, from);
    if (!(first instanceof Y.Item) || !first.deleted) continue;
    // Follow what Undo made of the character, as far as it goes.
    let id = from;
    for (let guard = 0; guard < 1000; guard++) {
      const item = Y.getItem(store, id);
      if (!(item instanceof Y.Item) || !item.deleted || !item.redone) break;
      id = Y.createID(item.redone.client, item.redone.clock + id.clock - item.id.clock);
    }
    if (id === from || Y.getState(store, id.client) <= id.clock) continue;
    const item = Y.getItem(store, id);
    if (!(item instanceof Y.Item) || item.deleted || item.parent !== doc.body) continue;
    doc.meta.set(moveKey(from), { client: id.client, clock: id.clock });
    moved = true;
  }
  return moved;
}

/** Unlock Pages. Final Draft keeps an empty LockedPages element, so FDX export writes one. */
export function unlockPages(doc: ScreenplayDoc): void {
  doc.meta.set("pageLocks", null);
}

// ----- Omitted scenes --------------------------------------------------------------------------------------

export const OMITTED = "OMITTED";

/**
 * A heading that stands in for an omitted scene: "OMITTED" with the scene's number. It keeps the scene's
 * paragraphs whole, synopses, notes and every field included, in an OmittedScene element; FDX export writes them
 * as Final Draft's OmittedScene paragraphs, and Restore Omitted Scene (unomitScene) puts them back.
 */
export function omittedHeading(number: string, sceneId: string, paragraphs: readonly Paragraph[]): Omit<Paragraph, "id"> {
  return {
    type: "sceneHeading", runs: [{ text: OMITTED }], sceneNumber: number, sceneId,
    fdx: { after: [{ name: "OmittedScene", attrs: [[OMITTED_NATIVE_ATTR, JSON.stringify(paragraphs)]], children: [] }] },
  };
}

export function isOmitted(paragraph: Paragraph): boolean {
  return paragraph.type === "sceneHeading" && !!paragraph.fdx?.after?.some((node) => node.name === "OmittedScene");
}

/**
 * The paragraphs an OMITTED heading keeps: as the app omitted them, or as Final Draft wrote them into its
 * OmittedScene element. Empty for any other paragraph.
 */
export function omittedParagraphs(heading: Paragraph): Paragraph[] {
  const node = heading.fdx?.after?.find((child) => child.name === "OmittedScene");
  if (!node) return [];
  const native = attrOf(node, OMITTED_NATIVE_ATTR);
  if (native !== undefined) {
    try {
      const paragraphs = JSON.parse(native) as unknown;
      if (Array.isArray(paragraphs)) return paragraphs as Paragraph[];
    } catch {
      // Not ours after all: read the Final Draft paragraphs below.
    }
  }
  return paragraphsFromFdxNodes(childNodes(node, "Paragraph"));
}

/**
 * Omit a scene (Production > Omit Scene): its text is replaced by an OMITTED heading that keeps its number and
 * scene ID, and keeps the scene's paragraphs. The scene ends where structure ends it: at the next heading, or at a
 * section title (an act or sequence) that follows it, which stays in the script.
 */
export function omitScene(doc: ScreenplayDoc, sceneId: string): void {
  const paragraphs = doc.paragraphs();
  const block = sceneBlocks(paragraphs).find((candidate) => candidate.sceneId === sceneId);
  if (!block) throw new RangeError(`No scene with ID ${sceneId}.`);
  const heading = paragraphs[block.start]!;
  if (isOmitted(heading)) return;
  const removed = paragraphs.slice(block.start, block.end);
  doc.ydoc.transact(() => {
    for (const paragraph of removed) doc.deleteParagraph(paragraph.id);
    doc.insertParagraph(block.start, omittedHeading(heading.sceneNumber ?? "", sceneId, removed));
  });
}

/** The runs between two character offsets, formatting kept. */
function sliceRuns(runs: readonly Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const start = Math.max(from, at), end = Math.min(to, at + run.text.length);
    if (end > start) out.push({ ...structuredClone(run), text: run.text.slice(start - at, end - at) });
    at += run.text.length;
  }
  return out;
}

/**
 * What the writer put on an OMITTED line besides the word OMITTED: text typed after it, or a heading joined onto
 * it with Backspace. Empty when the line reads just OMITTED.
 */
function omittedLineText(heading: Paragraph): Run[] {
  const text = plainTextOf(heading);
  const at = text.toUpperCase().indexOf(OMITTED);
  const runs = at < 0 ? structuredClone(heading.runs) : [...sliceRuns(heading.runs, 0, at), ...sliceRuns(heading.runs, at + OMITTED.length, text.length)];
  const kept = runs.map((run) => run.text).join("");
  const start = kept.length - kept.trimStart().length, end = kept.trimEnd().length;
  return end > start ? sliceRuns(runs, start, end) : [];
}

const HEADING_TEXT = /^(?:INT\.?\/EXT|INT|EXT|EST|I\/E)[. ]/i;

/**
 * Restore Omitted Scene: put an OMITTED heading's paragraphs back in its place, with their IDs (new ones where an
 * ID is in use again). The scene keeps the placeholder's number. Text the writer added to the OMITTED line stays,
 * as its own paragraph after the restored scene: a scene heading when it reads like one (a heading joined onto
 * the line), otherwise action. Returns false when there is nothing to restore.
 */
export function unomitScene(doc: ScreenplayDoc, headingId: string): boolean {
  if (!doc.has(headingId)) return false;
  const heading = doc.paragraph(headingId);
  const kept = omittedParagraphs(heading);
  if (!isOmitted(heading) || !kept.length) return false;
  const taken = new Set(doc.paragraphs().map((paragraph) => paragraph.id));
  taken.delete(headingId);
  const index = doc.indexOf(headingId);
  const extra = omittedLineText(heading);
  doc.ydoc.transact(() => {
    doc.deleteParagraph(headingId);
    kept.forEach((paragraph, k) => {
      const id = taken.has(paragraph.id) ? newId() : paragraph.id;
      taken.add(id);
      const restored: Paragraph = { ...structuredClone(paragraph), id };
      if (k === 0 && restored.type === "sceneHeading") {
        if (heading.sceneNumber !== undefined) restored.sceneNumber = heading.sceneNumber;
        restored.sceneId = heading.sceneId ?? restored.sceneId ?? id;
      }
      doc.insertParagraph(index + k, restored);
    });
    if (extra.length) {
      const type = HEADING_TEXT.test(extra.map((run) => run.text).join("")) ? "sceneHeading" : "action";
      doc.insertParagraph(index + kept.length, { type, runs: extra });
    }
  });
  return true;
}

const plainTextOf = (paragraph: Paragraph) => paragraph.runs.map((run) => run.text).join("");

/**
 * Keep numbered scenes that an edit removed while scene numbers are locked: each becomes an OMITTED heading
 * with its number, placed where the scene was (after the scene before it that is still there). `before` is the
 * paragraph list from before the edit; numbers in `ignore` get no placeholder. Returns how many were added.
 */
export function keepOmittedScenes(doc: ScreenplayDoc, before: readonly Paragraph[], ignore: ReadonlySet<string> = new Set()): number {
  const after = doc.paragraphs();
  const present = new Set(after.filter((p) => p.type === "sceneHeading" && p.sceneNumber).map((p) => p.sceneNumber!));
  const ranges = sceneBlocks(before);
  const lost = ranges.filter(({ start }) => {
    const heading = before[start]!;
    const number = heading.sceneNumber;
    // A heading with no text was never a scene anyone saw printed (an empty line passing through Scene Heading).
    return number !== undefined && number !== "" && !present.has(number) && !ignore.has(number) && !!plainTextOf(heading).trim();
  });
  if (!lost.length) return 0;
  const ids = new Set(after.map((paragraph) => paragraph.id));
  doc.ydoc.transact(() => {
    for (const range of lost) {
      const heading = before[range.start]!;
      const removed = before.slice(range.start, range.end).filter((paragraph) => !ids.has(paragraph.id));
      // Where the scene was: before the first paragraph from its heading on that is still there.
      const following = before.slice(range.start).find((paragraph) => ids.has(paragraph.id));
      const index = following ? doc.indexOf(following.id) : doc.paragraphs().length;
      doc.insertParagraph(index, omittedHeading(heading.sceneNumber!, heading.sceneId ?? heading.id, removed));
    }
  });
  return lost.length;
}

/**
 * Take back OMITTED placeholders whose scene came back: a heading with the same number is in the script again
 * (the edit that removed it was reversed by hand, or the scene was cut and pasted back). Returns how many went.
 */
export function restoreOmittedScenes(doc: ScreenplayDoc): number {
  const paragraphs = doc.paragraphs();
  const live = new Set(paragraphs.filter((p) => p.type === "sceneHeading" && p.sceneNumber && !isOmitted(p)).map((p) => p.sceneNumber!));
  const stale = paragraphs.filter((p) => isOmitted(p) && p.sceneNumber && live.has(p.sceneNumber));
  if (!stale.length) return 0;
  doc.ydoc.transact(() => {
    for (const paragraph of stale) doc.deleteParagraph(paragraph.id);
  });
  return stale.length;
}
