// Copy and paste. The clipboard carries Fountain as plain text, for other apps, and the paragraphs as
// JSON under our own type, so a paste within the app keeps every element type and mark.
import {
  cutRuns, isElementType, parseFountain, plainText, tagDefinitions, writeFountain,
  type Paragraph, type Run, type Script, type TextPosition,
} from "@screenplay/engine";

export const CLIPBOARD_TYPE = "application/x-screenplay+json";

/** The selected part of each paragraph from one position to another, in script order. */
export function selectedParagraphs(paragraphs: readonly Paragraph[], from: TextPosition, to: TextPosition): Paragraph[] {
  const start = paragraphs.findIndex((p) => p.id === from.paragraphId);
  const end = paragraphs.findIndex((p) => p.id === to.paragraphId);
  if (start < 0 || end < 0 || end < start) return [];
  return paragraphs.slice(start, end + 1).map((paragraph, i) => {
    const a = i === 0 ? from.offset : 0;
    const b = start + i === end ? to.offset : Infinity;
    return { ...paragraph, runs: cutRuns(paragraph.runs, a, b) };
  });
}

/** Plain text for other apps: the bare text of a piece of one paragraph, Fountain for more. */
export function clipboardText(paragraphs: readonly Paragraph[]): string {
  if (paragraphs.length === 1) return plainText(paragraphs[0]!.runs);
  return writeFountain({ titlePage: [], paragraphs: paragraphs.map((p) => ({ ...p, fdx: undefined })) as Paragraph[] }).trimEnd() + "\n";
}

/**
 * Marks clipboard JSON this window wrote. Only that JSON keeps its Final Draft extras on paste: the raw XML
 * they hold is written back verbatim on FDX save, so JSON from anywhere else must not carry it in.
 */
const SOURCE = crypto.randomUUID();

export function clipboardJson(paragraphs: readonly Paragraph[]): string {
  return JSON.stringify({ version: 1, source: SOURCE, paragraphs });
}

const FLAGS = ["bold", "italic", "underline", "strikeout", "allCaps", "note"] as const;

/** A run rebuilt from known fields only. Foreign runs lose styleExtra and FDX attributes. */
function cleanRun(value: unknown, own: boolean, tags: ReturnType<typeof tagDefinitions>): Run | null {
  const run = value as Partial<Run> | null;
  if (typeof run !== "object" || !run || typeof run.text !== "string") return null;
  const clean: Run = { text: run.text };
  for (const flag of FLAGS) if (run[flag] === true) clean[flag] = true;
  if (own && typeof run.styleExtra === "string") clean.styleExtra = run.styleExtra;
  if (own && run.fdx && typeof run.fdx === "object") clean.fdx = structuredClone(run.fdx);
  if (clean.fdx) {
    const { InklotTagId, TagNumber } = clean.fdx;
    const known = InklotTagId ? tags.some(t => t.id === InklotTagId) : tags.some(t => t.number === TagNumber);
    if (!known) {
      delete clean.fdx.InklotTagId;
      delete clean.fdx.TagNumber;
    }
  }
  return clean;
}

/** A pasted paragraph, if it has the shape the engine needs. The JSON can come from any app. */
function validParagraph(value: unknown, own: boolean, tags: ReturnType<typeof tagDefinitions>): Paragraph[] {
  const paragraph = value as Partial<Paragraph> | null;
  if (typeof paragraph !== "object" || !paragraph || !isElementType(paragraph.type) || !Array.isArray(paragraph.runs)) return [];
  const runs = paragraph.runs.map((run) => cleanRun(run, own, tags)).filter((run): run is Run => !!run);
  if (paragraph.runs.length && !runs.length) return [];
  const { dual } = paragraph;
  const clean: Paragraph = { id: typeof paragraph.id === "string" ? paragraph.id : "", type: paragraph.type, runs };
  if (typeof dual?.block === "string" && (dual.side === 1 || dual.side === 2)) clean.dual = { block: dual.block, side: dual.side };
  if (typeof paragraph.alignment === "string") clean.alignment = paragraph.alignment;
  if (paragraph.startsNewPage === true) clean.startsNewPage = true;
  if (typeof paragraph.depth === "number" && Number.isInteger(paragraph.depth) && paragraph.depth > 0) clean.depth = paragraph.depth;
  if (paragraph.boneyard === true) clean.boneyard = true;
  if (own && paragraph.fdx && typeof paragraph.fdx === "object") clean.fdx = structuredClone(paragraph.fdx);
  return [clean];
}

/** What a paste inserts: runs into the current paragraph, or whole paragraphs. */
export type Pasted = { runs: Run[] } | { paragraphs: Paragraph[] };

export function readClipboard(json: string | undefined, text: string | undefined, target?: Script): Pasted | null {
  if (json) {
    try {
      const data = JSON.parse(json) as { paragraphs?: unknown; source?: unknown };
      const own = data?.source === SOURCE;
      const tags = target ? tagDefinitions(target) : [];
      const paragraphs = Array.isArray(data?.paragraphs) ? data.paragraphs.flatMap((p) => validParagraph(p, own, tags)) : [];
      if (paragraphs.length === 1) return { runs: paragraphs[0]!.runs };
      if (paragraphs.length) return { paragraphs };
    } catch {
      // Fall back to the plain text.
    }
  }
  if (!text) return null;
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!normalized.includes("\n")) return normalized ? { runs: [{ text: normalized }] } : null;
  const paragraphs = parseFountain(normalized + "\n").paragraphs;
  if (paragraphs.length <= 1) return { runs: paragraphs[0]?.runs ?? [{ text: normalized }] };
  return { paragraphs };
}
