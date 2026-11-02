// Printed pages as positioned text: what the PDF, the print preview and printing all draw. Positions are in
// points from the top-left corner of the paper. Characters are spaced at the pagination's pitch (Final Draft
// 13's 7.02 points), so every line ends where pagination measured it.
import {
  PAGE_NUMBER_RIGHT, pageRevisions, plainText, revisionLabel, type Pagination, type PageLayout, type RevisionState, type Run, type Script,
} from "@screenplay/engine";

import type { TitleLine } from "../title-page/titlepage.ts";
import type { SceneNumberSide } from "./options.ts";

export const POINTS = 72;
export const FONT_SIZE = 12;
/** Courier's advance at 12 points; the difference to the pitch is applied as character spacing. */
export const COURIER_ADVANCE = 7.2;
/** Baseline below the top of a 12-point line. */
const BASELINE = 9.5;
/** Left scene numbers start here; right ones end here (Final Draft's positions). */
const SCENE_NUMBER_LEFT = 0.75;
const SCENE_NUMBER_RIGHT = 7.375;

export interface TextItem {
  text: string;
  /** Left edge and baseline, in points from the paper's top-left corner. */
  x: number;
  y: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** A line of a right-to-left paragraph: one item for the whole line, laid out by the bidi algorithm from x. */
  rtl?: { text: string; bold?: boolean; italic?: boolean; underline?: boolean }[];
}

export interface PageDrawing {
  /** "title" for the title page, otherwise the script page number. */
  key: string;
  items: TextItem[];
  /** Paper color, "#RRGGBB", for a revised page printed in its revision's color. */
  background?: string;
  /** The page carries revised text or a deletion mark. */
  revised?: boolean;
}

export interface RevisionPrinting {
  state: RevisionState;
  /** Marks in the right margin of revised lines. */
  marks: boolean;
  /** Revised pages on their revision's paper color. */
  colors: boolean;
  /** Only the revised pages (and no title page). */
  revisedOnly: boolean;
}

export interface DrawOptions {
  sceneNumbers: SceneNumberSide;
  header: string;
  /** Title page lines, or null to print none. */
  titlePage: TitleLine[] | null;
  revisions?: RevisionPrinting;
}

/** Where Final Draft prints revision marks, in inches from the left edge (its Revisions Location). */
function markColumn(state: RevisionState): number {
  const location = Number.parseFloat(state.fdx?.find(([name]) => name === "Location")?.[1] ?? "");
  return Number.isFinite(location) && location > 0 ? location : 7.75;
}

export function pitch(page: PageLayout): number {
  return POINTS / page.charsPerInch;
}

function lineTop(page: PageLayout, y: number): number {
  return page.top * POINTS + y * (POINTS / page.linesPerInch);
}

/**
 * Unicode's paragraph rule: the first strong letter decides the direction. Letters of the right-to-left scripts
 * count as right to left; digits, punctuation and marks are not strong and are skipped.
 */
const RTL_LETTER = /[\p{L}&&[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Mende_Kikakui}]]/v;
export function rightToLeft(text: string): boolean {
  // Also strong: letter-numbers (L), the LRM and RLM marks, and the Arabic letter mark and tatweel (AL).
  const strong = text.match(/[\p{L}\p{Nl}\u200E\u200F\u061C]/u);
  return !!strong && (RTL_LETTER.test(strong[0]) || /[\u0640\u200F\u061C]/.test(strong[0]));
}

/** Text items for runs starting at x, one per run. */
function runItems(runs: readonly Run[], x: number, y: number, step: number, style: { bold?: boolean; italic?: boolean; underline?: boolean } = {}): TextItem[] {
  const items: TextItem[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const bold = !!(run.bold || style.bold), italic = !!(run.italic || style.italic), underline = !!(run.underline || style.underline);
    items.push({ text: run.text, x, y, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}), ...(underline ? { underline } : {}) });
    x += run.text.length * step;
  }
  return items;
}

export function drawPages(script: Script, pagination: Pagination, options: DrawOptions): PageDrawing[] {
  const { page, elements } = pagination.layout;
  const step = pitch(page);
  const numbers = new Map(script.paragraphs.filter((p) => p.sceneNumber).map((p) => [p.id, p.sceneNumber!]));
  // Inline notes never print, so they never decide a paragraph's direction.
  const rtl = new Set(script.paragraphs.filter((p) => rightToLeft(plainText(p.runs.filter((run) => !run.note)))).map((p) => p.id));
  const drawings: PageDrawing[] = [];
  const revisions = options.revisions;
  const revised = revisions ? pageRevisions(script, pagination, revisions.state) : [];
  if (options.titlePage && !revisions?.revisedOnly) {
    drawings.push({
      key: "title",
      items: options.titlePage.flatMap((line) => runItems(line.runs, line.x * POINTS, lineTop(page, line.y) + BASELINE, step)),
    });
  }
  pagination.pages.forEach((sheet, index) => {
    const items: TextItem[] = [];
    const revision = revised[index];
    const isRevised = !!revision && (revision.marked.length > 0 || revision.setId !== undefined);
    if (revisions?.revisedOnly && !isRevised) return;
    const headerBaseline = page.header * POINTS + BASELINE;
    const numberLabel = `${sheet.number}.`;
    // Page 1 is not numbered; the others carry "2." at the header, as Final Draft prints them.
    if (index > 0) {
      items.push({ text: numberLabel, x: PAGE_NUMBER_RIGHT * POINTS - numberLabel.length * step, y: headerBaseline });
      if (options.header.trim()) items.push({ text: options.header.trim(), x: elements.action.left * POINTS, y: headerBaseline });
    }
    // A revised page names its latest revision in the header, left of the page number: "Blue Rev. 10/30/26".
    if (isRevised && revision.set) {
      const label = revisionLabel(revision.set);
      const room = index > 0 ? numberLabel.length + 4 : 0;
      if (label) items.push({ text: label, x: PAGE_NUMBER_RIGHT * POINTS - (label.length + room) * step, y: headerBaseline });
    }
    if (revisions?.marks && revision?.marked.length) {
      const mark = revision.set?.mark || "*";
      const x = markColumn(revisions.state) * POINTS;
      for (const lineIndex of revision.marked) {
        items.push({ text: mark, x, y: lineTop(page, sheet.lines[lineIndex]!.y) + BASELINE });
      }
    }
    for (const line of sheet.lines) {
      const baseline = lineTop(page, line.y) + BASELINE + (line.tall ? 2 : 0);
      const element = elements[line.type];
      const style = line.generated ? {} : { bold: !!element.bold, italic: !!element.italic, underline: !!element.underline };
      const runs = runItems(line.runs, line.x * POINTS, baseline, step, style);
      if (runs.length && rtl.has(line.paragraphId)) items.push({ text: runs.map((r) => r.text).join(""), x: line.x * POINTS, y: baseline, rtl: runs.map(({ x: _x, y: _y, ...run }) => run) });
      else items.push(...runs);
      const number = line.type === "sceneHeading" && line.from === 0 && !line.generated ? numbers.get(line.paragraphId) : undefined;
      if (number && (options.sceneNumbers === "both" || options.sceneNumbers === "left")) {
        items.push({ text: number, x: SCENE_NUMBER_LEFT * POINTS, y: baseline });
      }
      if (number && (options.sceneNumbers === "both" || options.sceneNumbers === "right")) {
        items.push({ text: number, x: SCENE_NUMBER_RIGHT * POINTS - number.length * step, y: baseline });
      }
    }
    const background = isRevised && revisions?.colors ? revision.set?.color : undefined;
    drawings.push({
      key: sheet.number, items,
      ...(background && background.toUpperCase() !== "#FFFFFF" ? { background } : {}),
      ...(isRevised ? { revised: true } : {}),
    });
  });
  return drawings;
}

// ----- SVG and HTML ----------------------------------------------------------------------------------------

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One page as an SVG element sized to the paper. */
export function pageSvg(drawing: PageDrawing, page: PageLayout): string {
  const width = page.width * POINTS, height = page.height * POINTS;
  const spacing = (pitch(page) - COURIER_ADVANCE).toFixed(4);
  const texts = drawing.items.map((item) => {
    const attrs = [`x="${item.x.toFixed(2)}"`, `y="${item.y.toFixed(2)}"`];
    if (item.bold) attrs.push('font-weight="bold"');
    if (item.italic) attrs.push('font-style="italic"');
    if (item.underline) attrs.push('text-decoration="underline"');
    // In right-to-left text the anchor's "end" is the left edge, so the line still starts at its margin.
    if (item.rtl) return `<text ${attrs.join(" ")} direction="rtl" unicode-bidi="embed" text-anchor="end">${item.rtl.map((run) => {
      const style = [run.bold ? 'font-weight="bold"' : "", run.italic ? 'font-style="italic"' : "", run.underline ? 'text-decoration="underline"' : ""].filter(Boolean).join(" ");
      return `<tspan${style ? " " + style : ""}>${escape(run.text)}</tspan>`;
    }).join("")}</text>`;
    return `<text ${attrs.join(" ")}>${escape(item.text)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${page.width}in" height="${page.height}in" `
    + `font-family="Courier, 'Courier New', monospace" font-size="${FONT_SIZE}" letter-spacing="${spacing}" fill="#000" style="white-space: pre">`
    + `<rect width="${width}" height="${height}" fill="${/^#[0-9a-f]{6}$/i.test(drawing.background ?? "") ? drawing.background : "#fff"}"/>${texts.join("")}</svg>`;
}

/** A complete HTML document of pages for the print service: one paper-sized page per sheet, no margins. */
export function printDocument(drawings: readonly PageDrawing[], page: PageLayout, title: string): string {
  const size = `${page.width}in ${page.height}in`;
  const pages = drawings.map((drawing) => `<div class="page">${pageSvg(drawing, page)}</div>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>
@page { size: ${size}; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { width: ${page.width}in; height: ${page.height}in; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
svg { display: block; }
</style></head><body>
${pages}
</body></html>`;
}

// ----- Editor page breaks and the caret's page -------------------------------------------------------------

export interface PageBreak {
  paragraphId: string;
  offset: number;
  pageNumber: string;
  more?: boolean;
  contd?: string;
}

/** Where each page after the first starts, for the editor to draw. */
export function pageBreaks(pagination: Pagination): PageBreak[] {
  const breaks: PageBreak[] = [];
  pagination.pages.forEach((page, index) => {
    if (index === 0) return;
    const first = page.lines.find((line) => !line.generated && line.paragraphId);
    if (!first) return;
    const contd = page.lines.find((line) => line.generated === "contd" && line.type === "character");
    const more = pagination.pages[index - 1]!.lines.some((line) => line.generated === "more" && line.type === "character");
    breaks.push({
      paragraphId: first.paragraphId, offset: first.from, pageNumber: page.number,
      ...(more ? { more } : {}), ...(contd ? { contd: contd.runs.map((run) => run.text).join("") } : {}),
    });
  });
  return breaks;
}

/** Index of the page holding a caret position, or -1 when the paragraph does not print. */
export function pageAt(pagination: Pagination, paragraphId: string, offset = 0): number {
  const start = pagination.positions.get(paragraphId)?.page;
  if (start === undefined) return -1;
  let found = start;
  for (let index = start; index < pagination.pages.length; index++) {
    const lines = pagination.pages[index]!.lines.filter((line) => line.paragraphId === paragraphId && !line.generated);
    if (!lines.length) break;
    if (lines[0]!.from <= offset) found = index;
  }
  return found;
}
