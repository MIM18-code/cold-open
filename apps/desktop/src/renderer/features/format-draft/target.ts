import { isElementType, isOmitted, pageLocks, plainText, sceneNumbersLocked, type Paragraph } from "@screenplay/engine";
import type { ProposedElement } from "../../../shared/channels/dictation.ts";
import type { Position, Selection } from "../../core/editor-bridge.ts";
import type { DocumentSession } from "../../core/session.ts";

/** Kept equal to @screenplay/dictation's MAX_TRANSCRIPT; covered by the pipeline tests. */
export const MAX_DRAFT_CHARS = 16_000;
export interface DraftTarget {
  sessionId: string;
  from: Position;
  to: Position;
  text: string;
  paragraphIds: string[];
  fingerprint: string;
  warnings: string[];
}

export function hasSelection(selection: Selection | null | undefined): boolean {
  return !!selection && (selection.anchor.paragraphId !== selection.head.paragraphId || selection.anchor.offset !== selection.head.offset);
}

export function captureDraftTarget(session: DocumentSession, selection: Selection | null, caret: string | null): DraftTarget {
  if (session.readOnly) throw new Error("This script is read-only.");
  const all = session.script().paragraphs;
  let from: Position, to: Position;
  if (hasSelection(selection)) {
    const a = all.findIndex((p) => p.id === selection!.anchor.paragraphId);
    const b = all.findIndex((p) => p.id === selection!.head.paragraphId);
    if (a < 0 || b < 0) throw new Error("Select the draft text again.");
    const forward = a < b || (a === b && selection!.anchor.offset <= selection!.head.offset);
    from = { ...(forward ? selection!.anchor : selection!.head) };
    to = { ...(forward ? selection!.head : selection!.anchor) };
  } else {
    const p = all.find((p) => p.id === (selection?.head.paragraphId ?? caret));
    if (!p) throw new Error("Put the caret in your rough draft, or select the text to format.");
    from = { paragraphId: p.id, offset: 0 };
    to = { paragraphId: p.id, offset: plainText(p.runs).length };
  }
  const start = all.findIndex((p) => p.id === from.paragraphId);
  let end = all.findIndex((p) => p.id === to.paragraphId);
  // Ending a selection at the next line's start does not select that line.
  if (end > start && to.offset === 0) {
    const previous = all[--end]!;
    to = { paragraphId: previous.id, offset: plainText(previous.runs).length };
  }
  const selected = all.slice(start, end + 1);
  if (from.offset < 0 || to.offset < 0 || from.offset > plainText(selected[0]!.runs).length || to.offset > plainText(selected.at(-1)!.runs).length) {
    throw new Error("The selected text changed. Select it again.");
  }
  if (pageLocks(session.doc)?.length || sceneNumbersLocked(session.doc) || selected.some((p) => p.sceneNumber || p.dual || isOmitted(p))) {
    throw new Error("Format Draft is for rough writing. Unlock production pages/scenes first, and keep numbered scenes and dual dialogue outside the selection.");
  }
  if (selected.some((p, i) => p.type === "sceneHeading" && (i > 0 || from.offset > 0))) {
    throw new Error("Format one existing scene at a time, keeping its heading outside the selection. This preserves the scene's identity.");
  }
  if (selected.some((p) => p.runs.some((r) => r.note) || p.fdx?.before?.length || p.fdx?.after?.length)) {
    throw new Error("This passage has attached notes or imported metadata. Select only the rough text so those annotations are kept.");
  }
  const text = selected.map((p, i) => plainText(p.runs).slice(i === 0 ? from.offset : 0, i === selected.length - 1 ? to.offset : undefined)).join("\n");
  if (!text.trim()) throw new Error("There is no draft text to format. Dictate or paste into the page first.");
  if (text.length > MAX_DRAFT_CHARS) throw new Error(`Select a shorter passage (up to ${MAX_DRAFT_CHARS.toLocaleString("en-US")} characters).`);
  const styled = selected.some((p) => p.runs.some((r) => r.bold || r.italic || r.underline || r.strikeout || r.allCaps || r.fdx));
  return { sessionId: session.id, from, to, text, paragraphIds: selected.map((p) => p.id), fingerprint: JSON.stringify(selected),
    warnings: styled ? ["Formatting replaces the selected text's inline styling. Surrounding text and its styling stay unchanged."] : [] };
}

export function targetIsCurrent(session: DocumentSession, target: DraftTarget): boolean {
  if (session.id !== target.sessionId || session.readOnly) return false;
  if (pageLocks(session.doc)?.length || sceneNumbersLocked(session.doc)) return false;
  const all = session.script().paragraphs;
  const start = all.findIndex((p) => p.id === target.from.paragraphId);
  return start >= 0 && JSON.stringify(all.slice(start, start + target.paragraphIds.length)) === target.fingerprint;
}

export function applyDraftFormatting(session: DocumentSession, target: DraftTarget, elements: readonly ProposedElement[]): Position {
  if (!targetIsCurrent(session, target)) throw new Error("The source passage changed while formatting. Nothing was replaced; select it and try again.");
  if (!elements.length || elements.length > 1000 || elements.some((e) => !isElementType(e.type) || typeof e.text !== "string")) {
    throw new Error("The formatter returned invalid screenplay elements. Your draft is unchanged.");
  }
  if (elements.reduce((n, e) => n + e.text.length, 0) > MAX_DRAFT_CHARS * 2) throw new Error("The formatted result is too large. Your draft is unchanged.");
  const original = session.doc.paragraph(target.from.paragraphId);
  if (original.type === "sceneHeading" && elements[0]!.type !== "sceneHeading" &&
      ((original.sceneId && original.sceneId !== original.id) || /^\s*(?:INT\b|EXT\b|I\/E\b|INTERIOR\b|EXTERIOR\b)/i.test(plainText(original.runs)))) throw new Error("The formatter removed the scene heading. Keep it outside the selection and try again.");
  const list: Paragraph[] = elements.map((e) => ({ id: "", type: e.type, runs: [{ text: e.text }] }));
  let ids: string[] = [];
  session.undo.stopCapturing();
  try {
    session.edit(() => {
      session.doc.deleteRange(target.from, target.to);
      ids = session.doc.insertParagraphsAt(target.from, list);
    });
  } finally {
    session.undo.stopCapturing();
  }
  const last = ids.at(-1)!;
  return { paragraphId: last, offset: plainText(session.doc.paragraph(last).runs).length };
}
