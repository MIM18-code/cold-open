// PDF export with pdf-lib: the standard Courier fonts at 12 points, every item at its exact position. Character
// spacing brings Courier's 7.2-point advance to the pagination's pitch, so lines end where pagination put them.
import { PDFDocument, StandardFonts, rgb, setCharacterSpacing, type PDFFont, type PDFPage } from "pdf-lib";
import type { PageLayout } from "@screenplay/engine";

import { COURIER_ADVANCE, FONT_SIZE, POINTS, pitch, type PageDrawing, type TextItem } from "./pages.ts";

export interface PdfInfo {
  title: string;
  author?: string;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

/**
 * Text as the PDF draws it: an accent typed as its own character after a letter (as some Mac apps paste it) joins
 * the letter, so "e" and a combining acute become "é", which Courier has.
 */
const composed = (text: string) => text.normalize("NFC");

/**
 * Characters the standard fonts can encode (WinAnsi). Anything else prints as "?" rather than failing the export;
 * exportPdf finds those first with unprintable() and asks the writer.
 */
function encodable(font: PDFFont): (text: string) => string {
  const set = new Set(font.getCharacterSet());
  return (text) => [...composed(text)].map((char) => (char === "\t" ? " " : set.has(char.codePointAt(0)!) ? char : "?")).join("");
}

let courierSet: Promise<ReadonlySet<number>> | undefined;

/** The code points the PDF's built-in Courier can print. */
export function pdfCharacters(): Promise<ReadonlySet<number>> {
  courierSet ??= PDFDocument.create().then(async (doc) => new Set((await doc.embedFont(StandardFonts.Courier)).getCharacterSet()));
  return courierSet;
}

export interface Unprintable {
  char: string;
  /** Page keys ("title", "1", "2A") where it appears, in page order. */
  pages: string[];
}

/** Characters on the pages that the PDF's font can't print (they would come out as "?"), in order of first use. */
export function unprintable(drawings: readonly PageDrawing[], printable: ReadonlySet<number>): Unprintable[] {
  const found = new Map<string, Unprintable>();
  for (const drawing of drawings) {
    for (const item of drawing.items) {
      for (const char of composed(item.text)) {
        if (char === "\t" || printable.has(char.codePointAt(0)!)) continue;
        let entry = found.get(char);
        if (!entry) found.set(char, (entry = { char, pages: [] }));
        if (entry.pages.at(-1) !== drawing.key) entry.pages.push(drawing.key);
      }
    }
  }
  return [...found.values()];
}

const and = (items: readonly string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "");

/** "the title page and pages 2, 5 and 9", from page keys. */
export function pageList(pages: readonly string[]): string {
  const numbers = pages.filter((key) => key !== "title");
  const shown = numbers.length > 4 ? [...numbers.slice(0, 3), `${numbers.length - 3} more`] : numbers;
  return [
    ...(pages.includes("title") ? ["the title page"] : []),
    ...(numbers.length ? [`${numbers.length === 1 ? "page" : "pages"} ${and(shown)}`] : []),
  ].join(" and ");
}

/** A character as the warning names it: itself, or its code when it can't be seen (a zero-width space, a lone accent). */
function charName(char: string): string {
  if (!/^[\p{M}\p{C}\p{Z}]$/u.test(char)) return char;
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}, an invisible character`;
}

/** "李 (page 1) and Ж (pages 2 and 3)", for the export warning. */
export function describeUnprintable(missing: readonly Unprintable[]): string {
  const shown = missing.slice(0, 6).map((entry) => `${charName(entry.char)} (${pageList(entry.pages)})`);
  return and(missing.length > 6 ? [...shown, `${missing.length - 6} more`] : shown);
}

function draw(page: PDFPage, item: TextItem, fonts: Fonts, clean: (text: string) => string, height: number, step: number): void {
  const font = item.bold && item.italic ? fonts.boldItalic : item.bold ? fonts.bold : item.italic ? fonts.italic : fonts.regular;
  const text = clean(item.text);
  const y = height - item.y;
  page.drawText(text, { x: item.x, y, size: FONT_SIZE, font, color: rgb(0, 0, 0) });
  if (item.underline) {
    const width = text.length * step - (step - COURIER_ADVANCE);
    page.drawLine({ start: { x: item.x, y: y - 1.5 }, end: { x: item.x + width, y: y - 1.5 }, thickness: 0.6, color: rgb(0, 0, 0) });
  }
}

export async function buildPdf(drawings: readonly PageDrawing[], layout: PageLayout, info: PdfInfo): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(info.title);
  if (info.author) doc.setAuthor(info.author);
  doc.setCreator("Cold Open");
  doc.setProducer("Cold Open (pdf-lib)");
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Courier),
    bold: await doc.embedFont(StandardFonts.CourierBold),
    italic: await doc.embedFont(StandardFonts.CourierOblique),
    boldItalic: await doc.embedFont(StandardFonts.CourierBoldOblique),
  };
  const clean = encodable(fonts.regular);
  const width = layout.width * POINTS, height = layout.height * POINTS;
  const step = pitch(layout);
  for (const drawing of drawings) {
    const page = doc.addPage([width, height]);
    const paper = /^#([0-9a-f]{6})$/i.exec(drawing.background ?? "")?.[1];
    if (paper) {
      const [r, g, b] = paper.match(/../g)!.map((byte) => Number.parseInt(byte, 16) / 255) as [number, number, number];
      page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(r, g, b) });
    }
    page.pushOperators(setCharacterSpacing(step - COURIER_ADVANCE));
    for (const item of drawing.items) draw(page, item, fonts, clean, height, step);
  }
  return doc.save();
}
