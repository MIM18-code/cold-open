// Applying a spoken edit command ("change Bob to Robert everywhere") to the script: find the matches for the
// preview, then replace them as one undoable edit. Nothing here runs until the writer accepts the suggestion.
import { type Script, plainText } from "@screenplay/engine";

import type { EditCommand } from "../../../shared/channels/dictation.ts";
import type { DocumentSession } from "../../core/session.ts";

export interface Match {
  paragraphId: string;
  start: number;
  end: number;
  matched: string;
  replacement: string;
  /** The text around the match, for the preview. */
  before: string;
  after: string;
}

const CONTEXT_CHARS = 28;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole words only, spaces in the phrase match any run of whitespace, case ignored. */
function pattern(find: string): RegExp {
  const body = find.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

/** BOB becomes ROBERT, Bob becomes Robert, whatever the writer's casing of what they said. */
export function matchCase(matched: string, replacement: string): string {
  const letters = matched.replace(/[^\p{L}]/gu, "");
  if (letters.length > 1 && matched === matched.toUpperCase()) return replacement.toUpperCase();
  if (replacement === replacement.toLowerCase() && /^\p{Lu}/u.test(matched)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

/** The paragraphs a scene-scoped command covers: from the current scene's heading to the next one. */
function sceneRange(script: Script, paragraphId: string | null): [number, number] {
  const all = script.paragraphs;
  const found = paragraphId ? all.findIndex((p) => p.id === paragraphId) : -1;
  const at = found >= 0 ? found : all.length - 1;
  let start = at;
  while (start > 0 && all[start]!.type !== "sceneHeading") start--;
  let end = at + 1;
  while (end < all.length && all[end]!.type !== "sceneHeading") end++;
  return [start, end];
}

export function findMatches(script: Script, command: Pick<EditCommand, "find" | "replacement" | "scope">, currentParagraphId: string | null = null): Match[] {
  if (!command.find.trim()) return [];
  const [from, to] = command.scope === "scene" ? sceneRange(script, currentParagraphId) : [0, script.paragraphs.length];
  const matches: Match[] = [];
  for (const paragraph of script.paragraphs.slice(from, to)) {
    const text = plainText(paragraph.runs);
    for (const found of text.matchAll(pattern(command.find))) {
      const start = found.index!;
      const end = start + found[0].length;
      matches.push({
        paragraphId: paragraph.id, start, end, matched: found[0], replacement: matchCase(found[0], command.replacement),
        before: text.slice(Math.max(0, start - CONTEXT_CHARS), start), after: text.slice(end, end + CONTEXT_CHARS),
      });
    }
  }
  return matches;
}

/** Replace the matches in one undoable edit. Returns how many were changed. */
export function applyMatches(session: DocumentSession, matches: Match[]): number {
  const byParagraph = Map.groupBy(matches, (match) => match.paragraphId);
  // Accepting is one undo step of its own, not merged into whatever the writer typed a moment ago.
  session.undo.stopCapturing();
  session.edit(() => {
    for (const [id, found] of byParagraph) {
      // Last match first, so earlier offsets stay valid. The new text goes in after the old, so it takes the
      // old text's formatting (bold, italic), then the old text is removed.
      for (const match of found.toSorted((a, b) => b.start - a.start)) {
        session.doc.insertText(id, match.end, match.replacement);
        session.doc.deleteText(id, match.start, match.end - match.start);
      }
    }
  });
  return matches.length;
}
