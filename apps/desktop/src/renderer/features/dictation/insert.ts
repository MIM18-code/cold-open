// Putting a take into the script. With an editor, the take goes in after the caret's paragraph. Without one,
// it goes at the end. In both cases an empty paragraph at the insertion point is filled with the first
// element instead of being left behind, so a take into a new script does not follow a blank scene heading.
import { plainText } from "@screenplay/engine";

import type { ProposedElement } from "../../../shared/channels/dictation.ts";
import type { EditorBridge } from "../../core/editor-bridge.ts";
import type { DocumentSession } from "../../core/session.ts";

export function insertElements(session: DocumentSession, editor: EditorBridge | null, elements: ProposedElement[], afterParagraphId?: string): number {
  if (!elements.length) return 0;
  const paragraphs = session.script().paragraphs;
  if (afterParagraphId !== undefined) {
    if (session.readOnly) throw new Error("Choose an editable script first.");
    const position = paragraphs.findIndex(p => p.id === afterParagraphId);
    if (position < 0) throw new Error("The attached passage was removed. Keep this draft until its attachment is resolved.");
    session.undo.stopCapturing();
    session.edit(() => {
      elements.forEach((element, i) => session.doc.insertParagraph(position + 1 + i,
        { type: element.type, runs: [{ text: element.text }] }));
    });
    return elements.length;
  }
  const caret = editor ? (editor.getSelection()?.head.paragraphId ?? editor.currentParagraphId()) : null;
  const anchor = paragraphs.find((p) => p.id === caret) ?? (editor ? undefined : paragraphs.at(-1));
  const empty = !!anchor && !plainText(anchor.runs);

  session.undo.stopCapturing();
  let rest = elements;
  if (anchor && empty) {
    const [first] = elements;
    session.edit(() => {
      session.doc.setType(anchor.id, first!.type);
      session.doc.insertText(anchor.id, 0, first!.text);
    });
    rest = elements.slice(1);
    editor?.setSelection({ paragraphId: anchor.id, offset: first!.text.length });
  }
  if (!rest.length) return elements.length;

  if (editor && anchor) {
    editor.insertParagraphs(rest.map((e) => ({ type: e.type, text: e.text })));
  } else {
    // No editor, or an editor with no caret: append after the last paragraph.
    session.edit(() => {
      let index = session.script().paragraphs.length;
      for (const element of rest) {
        session.doc.insertParagraph(index++, { type: element.type, runs: [{ text: element.text }] });
      }
    });
  }
  return elements.length;
}
