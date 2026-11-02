import { applyTag, castSuggestions, locateElement, scenesOf, type BreakdownSuggestion, type ElementSpan, type Script } from "@screenplay/engine";
import type { DocumentSession } from "../../core/session.ts";

export interface ReviewSuggestion extends BreakdownSuggestion { checked: boolean; headingId: string }

export function liveSpan(script: Script, row: ReviewSuggestion) {
  return liveSpans(script, [row]).get(row.id) ?? null;
}

export function liveSpans(script: Script, rows: ReviewSuggestion[]): Map<string, ElementSpan> {
  // Validate against the whole script: a capitalized introduction is cast because of a cue in another scene.
  const scenes = new Map(scenesOf(script.paragraphs).map((scene, index) => [scene.headingId, index]));
  const cast = new Map<number, BreakdownSuggestion[]>(), found = new Map<string, ElementSpan>();
  for (const row of rows) {
    const index = scenes.get(row.headingId);
    if (index === undefined) continue;
    if (!cast.has(index)) cast.set(index, castSuggestions(script, index));
    const span = row.source === "script"
      ? cast.get(index)!.find(s => s.paragraphId === row.paragraphId && s.quote === row.quote)
      : locateElement(script, index, row.quote);
    if (span && span.paragraphId === row.paragraphId && span.start === row.start && span.end === row.end) found.set(row.id, span);
  }
  return found;
}

export function tagReviewed(session: DocumentSession, rows: ReviewSuggestion[]): { tagged: number; skipped: number } {
  let tagged = 0, skipped = 0;
  session.undo.stopCapturing();
  try {
    session.edit(() => {
      for (const row of rows.filter(r => r.checked)) {
        // Rebuild after each application too: two proposals may overlap in the same batch.
        const span = liveSpan(session.doc.toScript(), row), label = row.label.trim();
        if (!span || !label || label.length > 200) { skipped++; continue; }
        applyTag(session.doc, { paragraphId: span.paragraphId, offset: span.start }, { paragraphId: span.paragraphId, offset: span.end }, row.category, label);
        tagged++;
      }
    });
  } finally { session.undo.stopCapturing(); }
  return { tagged, skipped };
}
