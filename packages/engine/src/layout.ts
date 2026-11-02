// Page and element geometry for a screenplay, in inches and lines (12-point Courier, 6 lines per inch).
// Final Draft 13 sets Courier slightly tight, 7.02 points per character instead of 7.2 (measured on its own
// PDFs), so a 6" action line holds 61 characters and a 3.5" dialogue line 35. charsPerInch is that pitch;
// PDF export draws with the same pitch so lines end where Final Draft's do. Defaults follow Final Draft's standard screenplay template. An FDX file's own
// ElementSettings and PageLayout override them (see fdxPaginationOptions in pagination.ts). The editor draws
// with the same numbers, so what the writer sees lines up with the printed page.
import type { ElementType } from "./model.ts";

export interface ElementLayout {
  /** Distance from the left edge of the paper to the start of the text, and to the end of the text. */
  left: number;
  right: number;
  /** Blank lines above the element. */
  spaceBefore: number;
  align: "left" | "center" | "right";
  caps: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Offset of the first line from `left`, in inches. Final Draft hangs a parenthetical's "(" 0.1" to the left. */
  firstIndent?: number;
  /** Line spacing: 1 single, 1.5, 2 double. */
  spacing?: number;
}

export interface PageLayout {
  width: number;
  height: number;
  top: number;
  bottom: number;
  /** Where the page number is printed, from the top edge. */
  header: number;
  footer: number;
  charsPerInch: number;
  linesPerInch: number;
}

export const PAGE: PageLayout = {
  width: 8.5,
  height: 11,
  top: 1,
  bottom: 1,
  header: 0.5,
  footer: 0.5,
  charsPerInch: 72 / 7.0225,
  linesPerInch: 6,
};

/** A4 paper with the same margins. Final Draft keeps the margins and fits more lines. */
export const PAGE_A4: PageLayout = { ...PAGE, width: 8.27, height: 11.69 };

export const ELEMENT_LAYOUT: Record<ElementType, ElementLayout> = {
  sceneHeading: { left: 1.5, right: 7.5, spaceBefore: 2, align: "left", caps: true },
  action: { left: 1.5, right: 7.5, spaceBefore: 1, align: "left", caps: false },
  character: { left: 3.5, right: 7.25, spaceBefore: 1, align: "left", caps: true },
  parenthetical: { left: 3.0, right: 5.5, spaceBefore: 0, align: "left", caps: false, firstIndent: -0.1 },
  dialogue: { left: 2.5, right: 6.0, spaceBefore: 0, align: "left", caps: false },
  transition: { left: 5.5, right: 7.1, spaceBefore: 1, align: "right", caps: true },
  shot: { left: 1.5, right: 7.5, spaceBefore: 1, align: "left", caps: true },
  general: { left: 1.5, right: 7.5, spaceBefore: 0, align: "left", caps: false },
  lyrics: { left: 2.5, right: 6.0, spaceBefore: 0, align: "left", caps: false, italic: true },
  castList: { left: 1.5, right: 7.5, spaceBefore: 0, align: "left", caps: true },
  newAct: { left: 1.0, right: 7.5, spaceBefore: 1, align: "center", caps: true, bold: true, underline: true },
  endOfAct: { left: 1.0, right: 7.5, spaceBefore: 2, align: "center", caps: true, bold: true, underline: true },
  section: { left: 1.5, right: 7.5, spaceBefore: 1, align: "left", caps: false },
  synopsis: { left: 1.5, right: 7.5, spaceBefore: 1, align: "left", caps: false, italic: true },
  note: { left: 1.5, right: 7.5, spaceBefore: 1, align: "left", caps: false },
};

/** Where the page number ends, from the left edge: Final Draft right-aligns it to the header's right indent. */
export const PAGE_NUMBER_RIGHT = 7.25;

/** Characters that fit on one line of an element (after its first line, which may hang). */
export function lineWidth(layout: ElementLayout, page: PageLayout = PAGE): number {
  return Math.max(1, Math.floor((layout.right - layout.left) * page.charsPerInch + 1e-6));
}

/** Text lines that fit between the top and bottom margins. A partial line does not fit. */
export function linesPerPage(page: PageLayout = PAGE): number {
  return Math.floor((page.height - page.top - page.bottom) * page.linesPerInch + 1e-6);
}
