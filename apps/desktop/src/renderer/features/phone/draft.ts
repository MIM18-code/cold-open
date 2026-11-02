import { parseFountain, plainText } from "@screenplay/engine";
import type { ProposedElement } from "../../../shared/channels/dictation.ts";

export function draftElements(text: string): ProposedElement[] {
  // A phone draft is a passage, so a leading "Title:" is action, not a title page.
  const elements = parseFountain("\n" + text).paragraphs
    .map(p => ({ type: p.type, text: plainText(p.runs), uncertainty: "" }));
  return elements.length ? elements : [{ type: "action", text, uncertainty: "" }];
}
