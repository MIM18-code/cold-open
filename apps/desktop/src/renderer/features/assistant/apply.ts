import { scriptNotes } from "@screenplay/engine";
import type { App } from "../../core/app.ts";
import { deleteInDocument } from "../editor/replace.ts";
import { replaceInParagraph } from "../proofread/apply.ts";
import { locate, locateCut, type Suggestion } from "./suggestions.ts";

export function applySuggestion(app: App, suggestion: Suggestion): { ok: true } | { error: string } {
  if (app.session.readOnly) return { error: "This script is read-only." };
  if (suggestion.cut) {
    const found = locateCut(app.session.script(), suggestion);
    if ("error" in found) return found;
    // Final Draft notes anchored to a range inside the cut would lose their place.
    const ids = new Set(found.paragraphIds);
    if (scriptNotes(app.session.doc).some((note) => (note.from && ids.has(note.from.paragraphId)) || (note.to && ids.has(note.to.paragraphId)))) {
      return { error: "That passage has a Final Draft note on it. Cut it by hand." };
    }
    if (app.editor) app.editor.deleteParagraphs(found.paragraphIds);
    else deleteInDocument(app.session, found.paragraphIds);
  } else {
    const found = locate(app.session.script(), suggestion);
    if ("error" in found) return found;
    replaceInParagraph(app, found.paragraphId, found.from, found.to, suggestion.replace);
  }
  return { ok: true };
}
