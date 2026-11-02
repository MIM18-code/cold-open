// Revision Mode and locked scene numbers, without touching the editor: the document's body is observed, and
// after every local edit (origin LOCAL_ORIGIN, the only undoable kind) the follow-up changes run in their own
// local transaction. That transaction always joins the edit's undo step (see joinEdit below; the capture timeout
// alone would split them when a slow listener runs in between), so one Undo takes back the typing and its
// revision marks together.
//
// While Revision Mode is on, inserted text (typed, pasted, dictated, replaced) takes the current set's
// RevisionID, and a deletion leaves a deletion mark in the paragraph where the text was, unless new text took
// its place (that text carries the mark). Deletion marks already in the script follow their text on every local
// edit, Revision Mode or not: into the new paragraph when Return splits the text after them, into the paragraph
// before when Backspace joins the two, and with a moved scene. While scene numbers are locked, a numbered scene
// that an edit removes comes back as an OMITTED heading with its number, a scene that comes back takes its
// placeholder away again, and new scenes get A-numbers once their heading has text. Pages an FDX file locked
// inside a paragraph are anchored to their first characters on the first edit, as Lock Pages anchors its own.
// Remote edits, undo and redo are left alone: they carry their own marks. After undo and redo, locked pages
// anchored to text the undo brought back are moved onto it (reanchorPageLocks).
import {
  DELETION_NODE, addDeletionMark, anchorFdxLocks, currentRevisionSet, deletionMarks, fdxLocksNeedAnchors, isOmitted,
  keepOmittedScenes, markInserted, numberAddedScenes, plainText, reanchorPageLocks, restoreOmittedScenes, revisionState, sceneNumbersLocked,
  type Paragraph, type ScreenplayDoc,
} from "@screenplay/engine";
import type * as Y from "yjs";

import { LOCAL_ORIGIN, type DocumentSession } from "../../core/session.ts";

const REVISION_ATTR = "fdx:RevisionID";
/** Origin of the meta write that moves a locked page's anchor after Undo: synced, and not undoable. */
const REANCHOR_ORIGIN = Symbol("reanchor-locks");

/** One change in a body event: text inserted, or characters deleted, at a body offset after the change. */
export interface BodyEdit {
  index: number;
  insert?: string;
  /** The inserted text already carries this RevisionID. */
  revision?: unknown;
  delete?: number;
}

/** The inserts and deletes of a body event, in order. Formatting changes are not edits. */
export function editsOf(delta: Y.YTextEvent["delta"]): BodyEdit[] {
  const edits: BodyEdit[] = [];
  let index = 0;
  for (const op of delta) {
    if (op.retain !== undefined) index += op.retain;
    else if (typeof op.insert === "string") {
      edits.push({ index, insert: op.insert, revision: op.attributes?.[REVISION_ATTR] });
      index += op.insert.length;
    } else if (op.insert !== undefined) index += 1;
    else if (op.delete !== undefined) edits.push({ index, delete: op.delete });
  }
  return edits;
}

/** Where a body offset from before a change is after it. Offsets inside deleted text go to where it was. */
export function mapIndex(delta: Y.YTextEvent["delta"], index: number): number {
  let before = 0, after = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      if (index < before + op.retain) return after + index - before;
      before += op.retain;
      after += op.retain;
    } else if (op.insert !== undefined) after += typeof op.insert === "string" ? op.insert.length : 1;
    else if (op.delete !== undefined) {
      if (index < before + op.delete) return after;
      before += op.delete;
    }
  }
  return after + index - before;
}

/**
 * Where a deletion mark's place (the body offset of the character after it) is after a change. Unlike mapIndex,
 * text inserted exactly there goes after the mark: typing at a mark leaves it before the new text, and Return
 * there leaves it at the end of the first half.
 */
function mapMark(delta: Y.YTextEvent["delta"], index: number): number {
  let before = 0, after = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      if (index < before + op.retain) return after + index - before;
      before += op.retain;
      after += op.retain;
    } else if (op.insert !== undefined) {
      if (index === before) return after;
      after += typeof op.insert === "string" ? op.insert.length : 1;
    } else if (op.delete !== undefined) {
      if (index < before + op.delete) return after;
      before += op.delete;
    }
  }
  return after + index - before;
}

/** Whether a change deleted the character at a body offset from before it. */
function deletedAt(delta: Y.YTextEvent["delta"], index: number): boolean {
  let before = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      if (index < before + op.retain) return false;
      before += op.retain;
    } else if (op.delete !== undefined) {
      if (index < before + op.delete) return true;
      before += op.delete;
    }
  }
  return false;
}

type Mark = { offset: number; setId: string };
const markKey = (mark: Mark) => `${mark.setId}@${mark.offset}`;

/**
 * The deletion marks an edit moved, as the new mark lists of the paragraphs it changed. Each mark goes where its
 * place in the text went: past typing or deleting before it, with the text after a split into the new paragraph,
 * with a paragraph joined onto the one before it (Backspace at its start) into that one; a mark in deleted text
 * closes up to where the text was, and two marks of a set that land together become one. A paragraph the edit
 * moved keeps its marks: a scene move deletes its paragraphs and inserts them again, marks and all.
 */
function followMarks(doc: ScreenplayDoc, before: readonly Paragraph[], delta: Y.YTextEvent["delta"]): Map<string, Mark[]> {
  const placed = new Map<string, Mark[]>();
  // Paragraphs whose old marks were all placed again: their marks are what landed in them.
  const replaced = new Set<string>();
  let start = 0;
  for (const paragraph of before) {
    const length = plainText(paragraph.runs).length;
    const marks = deletionMarks(paragraph);
    const moved = marks.length > 0 && doc.has(paragraph.id) && deletedAt(delta, start);
    // An edit that set the paragraph's marks itself (Clear Revision Marks) has put them where they belong.
    const own = marks.length > 0 && !moved && doc.has(paragraph.id)
      && deletionMarks(doc.paragraph(paragraph.id)).map(markKey).join() !== marks.map(markKey).join();
    if (marks.length && !moved && !own) {
      if (doc.has(paragraph.id)) replaced.add(paragraph.id);
      for (const mark of marks) {
        const at = doc.positionAt(mapMark(delta, start + 1 + Math.min(mark.offset, length)));
        if (!at) continue;
        const list = placed.get(at.paragraphId) ?? [];
        list.push({ offset: at.offset, setId: mark.setId });
        placed.set(at.paragraphId, list);
      }
    }
    start += 1 + length;
  }
  const changes = new Map<string, Mark[]>();
  for (const id of new Set([...replaced, ...placed.keys()])) {
    if (!doc.has(id)) continue;
    const current = deletionMarks(doc.paragraph(id));
    const next: Mark[] = [];
    const seen = new Set<string>();
    for (const mark of [...(replaced.has(id) ? [] : current), ...(placed.get(id) ?? [])]) {
      if (seen.has(markKey(mark))) continue;
      seen.add(markKey(mark));
      next.push(mark);
    }
    const same = next.length === current.length && next.every((mark, k) => markKey(mark) === markKey(current[k]!));
    if (!same) changes.set(id, next);
  }
  return changes;
}

/** Give a paragraph these deletion marks in place of the ones it has; its other FDX extras stay. */
function setMarks(doc: ScreenplayDoc, paragraphId: string, marks: readonly Mark[]): void {
  const paragraph = doc.paragraph(paragraphId);
  const others = (paragraph.fdx?.after ?? []).filter((node) => node.name !== DELETION_NODE);
  const after = [...others, ...marks.map((mark) => ({ name: DELETION_NODE, attrs: [["Offset", String(mark.offset)], ["RevisionID", mark.setId]] as [string, string][], children: [] }))];
  const fdx = { ...paragraph.fdx };
  if (after.length) fdx.after = after;
  else delete fdx.after;
  doc.setField(paragraphId, "fdx", Object.keys(fdx).length ? fdx : undefined);
}

/** A body offset on a paragraph boundary: what was deleted there were whole paragraphs, or their line breaks. */
function atBoundary(doc: ScreenplayDoc, index: number): boolean {
  const here = doc.positionAt(index), next = doc.positionAt(index + 1);
  return !here || !next || here.paragraphId !== next.paragraphId;
}

const text = (paragraph: Paragraph) => plainText(paragraph.runs).trim();

/** Numbered scene headings with text in `before` whose number no heading in `after` carries. */
function lostNumbers(before: readonly Paragraph[], after: readonly Paragraph[], ignore: ReadonlySet<string>): boolean {
  const present = new Set(after.filter((p) => p.type === "sceneHeading" && p.sceneNumber).map((p) => p.sceneNumber));
  return before.some((p) => p.type === "sceneHeading" && p.sceneNumber && !present.has(p.sceneNumber) && !ignore.has(p.sceneNumber) && text(p));
}

function hasDeletionMarks(paragraphs: readonly Paragraph[]): boolean {
  return paragraphs.some((paragraph) => paragraph.fdx?.after?.some((node) => node.name === DELETION_NODE));
}

/** An OMITTED placeholder whose number a live heading carries again. */
function returned(paragraphs: readonly Paragraph[]): boolean {
  const omitted = new Set(paragraphs.filter((p) => p.sceneNumber && isOmitted(p)).map((p) => p.sceneNumber));
  return omitted.size > 0 && paragraphs.some((p) => p.type === "sceneHeading" && p.sceneNumber && omitted.has(p.sceneNumber) && !isOmitted(p));
}

/** Start following a session's edits. Returns a function that stops. */
export function trackSession(session: DocumentSession): () => void {
  const doc = session.doc;
  // The paragraphs as they were before the edit being observed, to find scenes it removed.
  let snapshot: readonly Paragraph[] = doc.paragraphs();
  // This tracker's own follow-up transactions: only the text they insert is marked.
  const own = new WeakSet<Y.Transaction>();
  // A-numbers given out while this document was open. A scene numbered and removed in the same sitting was never
  // on a printed page, so it leaves no OMITTED placeholder.
  const assigned = new Set<string>();
  const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    const before = snapshot;
    snapshot = doc.paragraphs();
    // Undo brings deleted text back as new characters; a locked page anchored to that text moves onto them, in
    // the shared meta, so co-writers read the same page start (Undo's link to the old text is this replica's own).
    // Not an edit of its own: undo leaves it alone, and the redo stack stays.
    if (transaction.origin === session.undo) {
      if (doc.meta.get("pageLocks")) doc.ydoc.transact(() => reanchorPageLocks(doc), REANCHOR_ORIGIN);
      return;
    }
    if (transaction.origin !== LOCAL_ORIGIN) return;
    const state = revisionState(doc);
    const set = state.tracking ? currentRevisionSet(state) : undefined;
    const locked = sceneNumbersLocked(doc);
    // Pages an FDX file locked inside a paragraph get anchored to their text on the first edit.
    const anchorLocks = !own.has(transaction) && fdxLocksNeedAnchors(doc);
    // Nothing to follow (most scripts): skip the event's delta, which Yjs works out by walking the whole text.
    if (!set && !locked && !anchorLocks && !hasDeletionMarks(before)) return;
    const edits = editsOf(event.delta);
    const inserted = set ? edits.filter((edit) => edit.insert !== undefined && edit.revision !== set.id) : [];
    if (own.has(transaction)) {
      if (inserted.length) follow(() => markAll(inserted));
      return;
    }
    // Deletion marks already in the script keep to their text.
    const marks = edits.length && hasDeletionMarks(before) ? followMarks(doc, before, event.delta) : new Map<string, Mark[]>();
    const omitted = locked && lostNumbers(before, snapshot, assigned);
    // Text that replaced the deleted text carries the mark; an OMITTED placeholder stands where whole scenes went.
    const deleted = !set ? [] : [...new Set(edits.filter((edit) => edit.delete !== undefined).map((edit) => edit.index))].filter((index) =>
      !edits.some((edit) => edit.insert !== undefined && index >= edit.index && index <= edit.index + edit.insert.length)
      && !(omitted && atBoundary(doc, index)));
    const restore = locked && returned(snapshot);
    const unnumbered = locked && snapshot.some((p) => p.type === "sceneHeading" && p.sceneNumber === undefined && text(p))
      && snapshot.some((p) => p.sceneNumber !== undefined);
    if (!marks.size && !inserted.length && !deleted.length && !omitted && !restore && !unnumbered && !anchorLocks) return;
    follow(() => {
      // First, while the body is as the edit left it.
      if (anchorLocks) anchorFdxLocks(doc, before, (index) => mapIndex(event.delta, index), (index) => deletedAt(event.delta, index));
      for (const [paragraphId, list] of marks) if (doc.has(paragraphId)) setMarks(doc, paragraphId, list);
      markAll(inserted);
      for (const index of deleted) {
        const at = doc.positionAt(index);
        if (at) addDeletionMark(doc, at.paragraphId, at.offset, set!.id);
      }
      if (omitted) keepOmittedScenes(doc, before, assigned);
      if (restore) restoreOmittedScenes(doc);
      if (unnumbered) {
        const waiting = doc.paragraphs().filter((p) => p.type === "sceneHeading" && p.sceneNumber === undefined).map((p) => p.id);
        numberAddedScenes(doc);
        for (const id of waiting) {
          const number = doc.has(id) ? doc.paragraph(id).sceneNumber : undefined;
          if (number) assigned.add(number);
        }
      }
    });
    snapshot = doc.paragraphs();

    function markAll(list: readonly BodyEdit[]): void {
      for (const { index, insert } of list) markInserted(doc, index, insert!, set!.id);
    }
  };
  function follow(change: () => void): void {
    session.edit(() => {
      if (doc.ydoc._transaction) own.add(doc.ydoc._transaction);
      change();
    });
  }
  // A follow-up belongs to the edit that caused it, however long other listeners took in between: the undo
  // manager asks captureTransaction first when it records a transaction, and for a follow-up the answer comes
  // with "the last change was just now", so it joins the edit's undo step instead of starting one.
  const undo = session.undo;
  const capture = undo.captureTransaction;
  const joinEdit = (transaction: Y.Transaction) => {
    if (own.has(transaction) && undo.undoStack.length) undo.lastChange = Date.now();
    return capture(transaction);
  };
  undo.captureTransaction = joinEdit;
  doc.body.observe(observer);
  return () => {
    doc.body.unobserve(observer);
    if (undo.captureTransaction === joinEdit) undo.captureTransaction = capture;
  };
}
