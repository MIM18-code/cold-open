// Replacing text in one paragraph, for fixes other features apply (proofreading, the assistant, find and replace).
import type { DocumentSession } from "../../core/session.ts";

/** Replace text as one undo step of its own (not merged with recent typing), keeping the replaced text's formatting. */
export function replaceInDocument(session: DocumentSession, paragraphId: string, from: number, to: number, text: string): void {
  session.undo.stopCapturing();
  session.edit(() => session.doc.replaceText(paragraphId, from, to, text));
  session.undo.stopCapturing();
}
