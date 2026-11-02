// Applying a text fix to one paragraph: through the editor when it is open, otherwise straight on the document.
// Either way it is one undo step of its own and the fix keeps the formatting of the text it replaces.
import type { App } from "../../core/app.ts";
import { replaceInDocument } from "../editor/replace.ts";

export function replaceInParagraph(app: App, paragraphId: string, from: number, to: number, text: string): void {
  if (app.editor) app.editor.replaceText(paragraphId, from, to, text);
  else replaceInDocument(app.session, paragraphId, from, to, text);
}
