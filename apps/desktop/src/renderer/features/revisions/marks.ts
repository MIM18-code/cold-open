// Revision marks in the editor: revised text tinted with its set's paper color, and the set's mark (an asterisk)
// in the right margin, drawn through the editor bridge's decorations. Each revised stretch and each deletion
// mark is an inline decoration whose ::after pseudo-element sits at Final Draft's mark column (7.75" from the
// paper's edge) on the line where the stretch ends; the paragraph gets a class too, for its whole extent.
import {
  ELEMENT_LAYOUT, deletionMarks, importedDeletionMarks, plainText, revisedRanges, revisionLabel,
  type ElementType, type Paragraph, type RevisionState, type Script,
} from "@screenplay/engine";

import type { Decoration } from "../../core/editor-bridge.ts";

/** A CSS-safe class suffix for a set ID. */
export function setClass(id: string): string {
  return `rev-set-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Decorations for every revised paragraph. Nothing when marks are hidden. */
export function revisionDecorations(script: Pick<Script, "paragraphs" | "fdx">, state: RevisionState): Decoration[] {
  if (!state.showMarks) return [];
  const sets = new Map(state.sets.map((set) => [set.id, set]));
  const title = (id: string) => {
    const set = sets.get(id);
    return set ? revisionLabel(set) : `Revision ${id}`;
  };
  const imported = importedDeletionMarks(script);
  const out: Decoration[] = [];
  for (const paragraph of script.paragraphs as readonly Paragraph[]) {
    const ranges = revisedRanges(paragraph);
    const deletions = [...deletionMarks(paragraph).filter((mark) => mark.setId !== "0"), ...(imported.get(paragraph.id) ?? [])];
    if (!ranges.length && !deletions.length) continue;
    const latest = [...ranges.map((range) => range.setId), ...deletions.map((mark) => mark.setId)].at(-1)!;
    out.push({ paragraphId: paragraph.id, className: `rev-para ${setClass(latest)}` });
    for (const range of ranges) {
      out.push({ paragraphId: paragraph.id, from: range.from, to: range.to, className: `rev-text ${setClass(range.setId)}`, title: title(range.setId) });
    }
    const length = plainText(paragraph.runs).length;
    for (const mark of deletions) {
      // A deletion has no text of its own: the character beside it carries the mark.
      const from = Math.max(0, Math.min(mark.offset, length) - (mark.offset >= length ? 1 : 0));
      if (length) out.push({ paragraphId: paragraph.id, from, to: from + 1, className: `rev-del ${setClass(mark.setId)}`, title: `${title(mark.setId)}: text deleted` });
    }
  }
  return out;
}

const MARK_COLUMN = 7.75;

/**
 * Colors and marks per set, and the mark column, as a style sheet. The column is measured from each element's
 * left edge, which the editor draws from the script's own layout and publishes as --editor-left.
 */
export function revisionStyles(state: RevisionState): string {
  const rules: string[] = [];
  for (const [type, layout] of Object.entries(ELEMENT_LAYOUT) as [ElementType, (typeof ELEMENT_LAYOUT)[ElementType]][]) {
    rules.push(`.editor-t-${type} { --rev-mark-x: calc(${MARK_COLUMN} - var(--editor-left, ${layout.left})); }`);
  }
  // Dual dialogue columns start at 1.5" and about 4.6".
  rules.push(`.editor-column-1 .editor-p { --rev-mark-x: ${(MARK_COLUMN - 1.5).toFixed(3)}; }`);
  rules.push(`.editor-column-2 .editor-p { --rev-mark-x: ${(MARK_COLUMN - 4.625).toFixed(3)}; }`);
  for (const set of state.sets) {
    const color = /^#[0-9a-f]{6}$/i.test(set.color) ? set.color : "#C6EDFE";
    const mark = JSON.stringify((set.mark ?? "").replace(/["\\<>{};]/g, "").slice(0, 2) || "*");
    rules.push(`.${setClass(set.id)} { --rev-color: ${color}; --rev-mark: ${mark}; }`);
  }
  return rules.join("\n");
}
