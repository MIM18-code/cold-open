import { plainText } from "@screenplay/engine";
import type { ProposedElement } from "../../../shared/channels/dictation.ts";
import type { EditorBridge, Position } from "../../core/editor-bridge.ts";
import type { DocumentSession } from "../../core/session.ts";
import { applyDraftFormatting, captureDraftTarget, hasSelection, type DraftTarget } from "../format-draft/target.ts";

export type DeliveryTarget = { sessionId: string; replacement?: DraftTarget };

/** Only a highlight present when the take starts authorizes replacing script text. */
export function captureDelivery(session: DocumentSession, editor: EditorBridge | null): DeliveryTarget {
  if (session.readOnly) throw new Error("This script is read-only.");
  const selection = editor?.getSelection();
  return { sessionId: session.id, ...(hasSelection(selection) ? {
    replacement: captureDraftTarget(session, selection!, null),
  } : {}) };
}

export function scriptEnd(session: DocumentSession): Position | null {
  const last = session.script().paragraphs.at(-1);
  return last ? { paragraphId: last.id, offset: plainText(last.runs).length } : null;
}

/** Append at the current end, even if the writer moved the caret while the model worked. */
export function deliverElements(session: DocumentSession, target: DeliveryTarget, elements: ProposedElement[]): Position {
  if (session.id !== target.sessionId || session.readOnly) throw new Error("The document changed. Your take has been kept for review.");
  if (target.replacement) return applyDraftFormatting(session, target.replacement, elements);
  if (!elements.length) throw new Error("There are no screenplay elements to insert.");
  let ids: string[] = [];
  session.undo.stopCapturing();
  try {
    session.edit(() => {
      const end = scriptEnd(session);
      if (end) ids = session.doc.insertParagraphsAt(end, elements.map(e => ({ id: "", type: e.type, runs: [{ text: e.text }] })));
      else ids = elements.map(e => session.doc.insertParagraph(session.script().paragraphs.length, { type: e.type, runs: [{ text: e.text }] }));
    });
  } finally {
    session.undo.stopCapturing();
  }
  const last = ids.at(-1)!;
  return { paragraphId: last, offset: plainText(session.doc.paragraph(last).runs).length };
}
