import { plainText, type Paragraph, type ScreenplayDoc, type TextPosition } from "@screenplay/engine";
import * as Y from "yjs";
import { simpleDiffString } from "lib0/diff";

export const RECORD_PREFIX = "workbench.record.";
export const DRAFT_TEXT_PREFIX = "workbench.dialogueText.";
export type RecordKind = "note" | "bookmark" | "cut" | "alternative" | "beat";
export interface Anchor { paragraphId: string; from: number; to: number; quote: string; start: number[]; end: number[]; }
export interface ProjectRecord {
  id: string; revision: string; kind: RecordKind; title: string; text: string; created: string; updated: string;
  phoneReceipt?: string;
  dialogueDraft?: { paragraphId: string; base: string; textKey?: string };
  anchor?: Anchor; author?: string; resolved?: boolean; parentId?: string; paragraphs?: Paragraph[];
}
const kinds = new Set<RecordKind>(["note", "bookmark", "cut", "alternative", "beat"]);
function recordText(doc: ScreenplayDoc, record: ProjectRecord): ProjectRecord {
  const key = record?.dialogueDraft?.textKey;
  const text = key ? doc.meta.get(DRAFT_TEXT_PREFIX + key) : undefined;
  // Snapshot restoration may have copied meta.toJSON(), which flattens Y.Text to a string.
  if (!(text instanceof Y.Text || typeof text === "string")) return record;
  const value = text.toString();
  // A draft's text changes without its record changing (typing, Undo, a co-writer), so the revision an edit form
  // checks includes the text: a form opened before any such change refuses to save over it.
  return { ...record, text: value, revision: `${record.revision}:${textDigest(value)}` };
}

// FNV-1a, enough to tell two versions of a draft apart; not a security boundary.
function textDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36) + value.length.toString(36);
}

/** Keep unchanged characters so disconnected writers retain each other's insertions. */
export function editDraftText(text: Y.Text, next: string): void {
  if (next.length > 20000) throw new Error("This project item is too large or invalid.");
  const diff = simpleDiffString(text.toString(), next);
  if (diff.remove) text.delete(diff.index, diff.remove);
  if (diff.insert) text.insert(diff.index, diff.insert);
}

export function records(doc: ScreenplayDoc, kind?: RecordKind, includeUnchangedDrafts = false): ProjectRecord[] {
  return [...doc.meta.entries()].filter(([key]) => key.startsWith(RECORD_PREFIX))
    .map(([, value]) => recordText(doc, value as ProjectRecord))
    .filter(r => r && typeof r.id === "string" && typeof r.revision === "string" && kinds.has(r.kind)
      && typeof r.text === "string" && typeof r.title === "string" && typeof r.updated === "string"
      && typeof r.created === "string" && (!kind || r.kind === kind)
      && (includeUnchangedDrafts || !r.dialogueDraft || r.text !== r.dialogueDraft.base))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}
export function putRecord(doc: ScreenplayDoc, record: ProjectRecord, expectedRevision?: string): void {
  if (!record || !/^[a-zA-Z0-9_-]{12,80}$/.test(record.id) || !kinds.has(record.kind)
    || record.title.length > 160 || record.text.length > 20000 || JSON.stringify(record).length > 500_000) {
    throw new Error("This project item is too large or invalid.");
  }
  const current = doc.meta.get(RECORD_PREFIX + record.id) as ProjectRecord | undefined;
  if (expectedRevision !== undefined && (current && recordText(doc, current))?.revision !== expectedRevision) {
    throw new Error("This item changed in another window. Reopen it before applying your edits.");
  }
  if (!current && records(doc, undefined, true).length >= 400) {
    throw new Error("This draft already has 400 project items. Export or remove unwanted items first.");
  }
  if (record.dialogueDraft?.textKey) {
    const key = DRAFT_TEXT_PREFIX + record.dialogueDraft.textKey;
    const existing = doc.meta.get(key);
    const text = existing instanceof Y.Text ? existing : new Y.Text();
    if (text !== existing) doc.meta.set(key, text);
    editDraftText(text, record.text);
  }
  doc.meta.set(RECORD_PREFIX + record.id, structuredClone({
    ...record, text: record.dialogueDraft?.textKey ? "" : record.text,
    revision: crypto.randomUUID(), updated: new Date().toISOString(),
  }));
}
export function createRecord(kind: RecordKind, title: string, text: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  const now = new Date().toISOString();
  return { ...extra, id: crypto.randomUUID(), revision: crypto.randomUUID(), kind, title: title.slice(0,160), text, created: now, updated: now };
}
export function anchorAt(doc: ScreenplayDoc, from: TextPosition, to = from): Anchor {
  const p = doc.paragraph(from.paragraphId), text = plainText(p.runs);
  const a = Math.max(0, Math.min(from.offset, text.length));
  const b = to.paragraphId === p.id ? Math.max(a, Math.min(to.offset, text.length)) : text.length;
  return { paragraphId: p.id, from: a, to: b, quote: text.slice(a,b),
    start: Array.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.body, doc.bodyIndex({ paragraphId:p.id, offset:a }), 1))),
    end: Array.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.body, doc.bodyIndex({ paragraphId:p.id, offset:b }), -1))) };
}
/** Resolve relative positions only inside their original paragraph. A moved paragraph can recover an exact,
 * unique quote; ambiguous or deleted text becomes an explicit orphan instead of a guessed attachment. */
export function resolveAnchor(doc: ScreenplayDoc, anchor?: Anchor): { paragraphId: string; from: number; to: number } | null {
  if (!anchor || !doc.has(anchor.paragraphId)) return null;
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Uint8Array.from(anchor.start)), doc.ydoc);
    const b = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Uint8Array.from(anchor.end)), doc.ydoc);
    if (a?.type === doc.body && b?.type === doc.body) {
      const start = doc.positionAt(a.index), end = doc.positionAt(b.index);
      if (start?.paragraphId === anchor.paragraphId && end?.paragraphId === anchor.paragraphId && end.offset >= start.offset && (end.offset > start.offset || !anchor.quote)) return { paragraphId: anchor.paragraphId, from: start.offset, to: end.offset };
    }
  } catch { /* Invalid or obsolete references never mutate the document. */ }
  const text = plainText(doc.paragraph(anchor.paragraphId).runs);
  if (!anchor.quote) return { paragraphId: anchor.paragraphId, from: 0, to: 0 };
  const at = text.indexOf(anchor.quote);
  return at >= 0 && text.indexOf(anchor.quote, at + 1) < 0 ? { paragraphId: anchor.paragraphId, from: at, to: at + anchor.quote.length } : null;
}
