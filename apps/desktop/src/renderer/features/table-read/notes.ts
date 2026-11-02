import type { ReadCue, ScreenplayDoc } from "@screenplay/engine";
import { anchorAt, createRecord } from "../rewrite/records.ts";

export function listeningNote(session: { doc: ScreenplayDoc; readOnly: boolean }, cue: ReadCue,
  readSession: { id: string; revision: string }) {
  if (session.readOnly) throw new Error("This script is read-only.");
  const span = cue.source[0];
  if (!span || !session.doc.has(span.paragraphId)) throw new Error("That passage was removed.");
  const extra = {
    anchor: anchorAt(session.doc, { paragraphId: span.paragraphId, offset: span.from },
      { paragraphId: span.paragraphId, offset: span.to }),
    readSession: { ...readSession, source: structuredClone(cue.source), spokenText: cue.text },
  };
  return createRecord("note", "Listening note", "", extra);
}
