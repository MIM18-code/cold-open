import { NON_PRINTING, TAG_CATEGORIES, tagDefinitions, type Script } from "@screenplay/engine";
import type { Decoration } from "../../core/editor-bridge.ts";
import { liveSpans, type ReviewSuggestion } from "./review.ts";

export const categoryClass = (category: string) => {
  const index = TAG_CATEGORIES.findIndex(([name]) => name === category);
  return `breakdown-color-${index < 0 ? 13 : index}`;
};

export function breakdownHighlights(script: Script, tagged: boolean, pending: ReviewSuggestion[]): Decoration[] {
  const marks: Decoration[] = [], definitions = new Map(tagDefinitions(script).map(d => [d.number, d]));
  if (tagged) for (const paragraph of script.paragraphs) {
    if (NON_PRINTING.has(paragraph.type)) continue;
    let at = 0;
    for (const run of paragraph.runs) {
      const definition = definitions.get(run.fdx?.TagNumber ?? "");
      if (run.fdx?.TagNumber && !run.note) marks.push({ paragraphId: paragraph.id, from: at, to: at + run.text.length,
        className: `breakdown-tag ${categoryClass(definition?.category ?? "Miscellaneous")}`, title: definition ? `${definition.category}: ${definition.label}` : "Unresolved breakdown tag" });
      at += run.text.length;
    }
  }
  const spans = liveSpans(script, pending);
  for (const row of pending) {
    const span = spans.get(row.id);
    if (span) marks.push({ paragraphId: span.paragraphId, from: span.start, to: span.end,
      className: `breakdown-pending ${categoryClass(row.category)}`, title: `Suggested ${row.category}: ${row.label}` });
  }
  return marks;
}
