// Pagination: lays a script out on pages the way Final Draft does. The interface (paginate, Pagination, Page,
// Line and the helpers) is fixed: the editor, PDF export, reports and revisions use it.
//
// The script is first cut into groups that move as a unit: a scene heading, a speech (character cue,
// parentheticals and dialogue), a dual-dialogue block, an action paragraph, a transition. Groups that must
// share a page form a chain: a scene heading keeps with what follows it, a transition keeps with what comes
// before it. A chain that does not fit is split at the point that fills the most of the page, using only
// the breaks Final Draft allows: action and dialogue at sentence ends with two lines either side, a speech
// between its paragraphs, never right after a cue or a parenthetical. A broken speech prints (MORE) under the
// break and CHARACTER (CONT'D) above the rest. Everything else starts a new page.
import { ELEMENT_LAYOUT, PAGE, linesPerPage, type ElementLayout, type PageLayout } from "./layout.ts";
import { NON_PRINTING, type ElementType, type Paragraph, type Run, type Script, type XmlNode } from "./model.ts";
import { templateBreakBefore } from "./template-rules.ts";

export interface PaginationOptions {
  page?: PageLayout;
  /** Per-element overrides, usually read from an FDX file's ElementSettings. */
  elements?: Partial<Record<ElementType, Partial<ElementLayout>>>;
  /** Add (CONT'D) to a character cue when the same character speaks again after only action. Default true. */
  autoContinueds?: boolean;
  /** Print (MORE) and (CONT'D) when dialogue breaks across a page. Default true. */
  dialogueBreaks?: boolean;
  /** Break action and dialogue only at the end of a sentence (Final Draft's default). Default true. */
  breakAtSentences?: boolean;
  /** How an element keeps with its neighbours, as Final Draft's PaginateAs: a shot paginates as a scene heading. */
  paginateAs?: Partial<Record<ElementType, ElementType>>;
  /** Elements that always start a page, from the document template: acts, and every scene in multi-camera. */
  breakBefore?: readonly ElementType[];
  /** Text under a dialogue break, and after the character name above the rest. Defaults "(MORE)" and "(CONT'D)". */
  more?: string;
  contd?: string;
  /** Print (CONTINUED) at the foot and CONTINUED: at the head of a page when a scene runs across it. Default off. */
  sceneContinueds?: boolean;
  sceneBottom?: string;
  sceneTop?: string;
  /**
   * Locked pages, in script order: each locked page starts where it started when the pages were locked. Text
   * that outgrows a locked page runs onto A-pages (12A, 12B); a locked page whose text is all gone gives its
   * number to the page before it (12-13), as Final Draft does.
   */
  locks?: readonly PageLock[];
}

/** Where a locked page starts. */
export interface PageLock {
  /** The printed page number: "12", "12A", or "12-13" for a page that took over a vanished page's number. */
  number: string;
  /** The paragraph the page starts in and the character offset where it starts (0 for a whole paragraph). */
  paragraphId: string;
  offset: number;
  /** Paragraphs that started on the page when it was locked, so the page is found again if the first one is deleted. */
  paragraphIds?: string[];
  /** Final Draft's lock level: 0 for pages from the first lock, one more for pages first locked by each relock. */
  level?: number;
}

/** One printed line. */
export interface Line {
  paragraphId: string;
  type: ElementType;
  /** Character range of this line within the paragraph's text. Empty for generated lines such as (MORE). */
  from: number;
  to: number;
  /** The text as printed: capitals applied, inline notes left out, any automatic (CONT'D) appended. */
  runs: Run[];
  /** Left edge in inches from the paper's edge; already accounts for right and center alignment. */
  x: number;
  /** Line number on the page, from 0 at the top margin. Fractional only with 1.5 line spacing. */
  y: number;
  /** Generated text that is not in the script: (MORE), CHARACTER (CONT'D), (CONTINUED). */
  generated?: "more" | "contd";
  /** Dual dialogue column: 1 left, 2 right. */
  column?: 1 | 2;
  /** Printed text appended to the script's text, such as an automatic " (CONT'D)" on a cue. Already in runs. */
  suffix?: string;
  /** Holds fallback-font glyphs, so the line is 16 points tall and its text sits 2 points lower. */
  tall?: true;
}

export interface Page {
  /** Printed page number, "1", "2", or "12A" once pages are locked. */
  number: string;
  lines: Line[];
  /** Scene numbers and headings starting on this page. */
  sceneIds: string[];
  /** An A-page: added after a locked page because the text outgrew it. */
  added?: true;
}

export interface Pagination {
  pages: Page[];
  layout: { page: PageLayout; elements: Record<ElementType, ElementLayout> };
  /** First page and line of every printed paragraph. */
  positions: Map<string, { page: number; line: number }>;
}

const DEFAULT_PAGINATE_AS: Partial<Record<ElementType, ElementType>> = {
  shot: "sceneHeading", newAct: "sceneHeading", castList: "action", general: "action", lyrics: "dialogue",
};
// Lines that must stay on each side of a break in a paragraph or a speech.
const MIN_LINES = 2;
const EPSILON = 1e-6;

/** Whole characters that fit in a width in inches. */
function columns(inches: number, charsPerInch: number): number {
  return Math.max(1, Math.floor(inches * charsPerInch + EPSILON));
}

export function resolveLayout(options: PaginationOptions = {}): Pagination["layout"] {
  const elements = { ...ELEMENT_LAYOUT };
  for (const [type, override] of Object.entries(options.elements ?? {})) {
    elements[type as ElementType] = { ...elements[type as ElementType], ...override };
  }
  return { page: options.page ?? PAGE, elements };
}

/** Wrap text to a width at spaces and after hyphens; a word longer than the line is broken. Returns [from, to) ranges. */
export function wrap(text: string, width: number): [number, number][] {
  return wrapLines(text, width, width);
}

/**
 * East Asian wide characters in the Basic Multilingual Plane fill two Courier columns. (Emoji and other astral
 * characters are two UTF-16 units, so index arithmetic already counts them as two.) Lines may break between them.
 */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u3098\u309B-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** CJK line-breaking rules (kinsoku): closing punctuation never starts a line, and opening brackets never end one. */
const NO_LINE_START = /[、。，．・：；？！ー々〟」』）］｝〕〉》】〙〗ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/;
const NO_LINE_END = /[「『（［｛〔〈《【〘〖〝]/;

/** wrap() with a different width for the first line (a hanging or indented first line). */
function wrapLines(text: string, firstWidth: number, width: number): [number, number][] {
  const lines: [number, number][] = [];
  // Column offsets and grapheme boundaries, only for text with wide characters; everything else keeps plain
  // index arithmetic. A grapheme is two columns when wide or an emoji, else one, and a line never ends inside one.
  let cols: number[] | undefined, edges: Set<number> | undefined;
  if (WIDE.test(text)) {
    cols = new Array<number>(text.length + 1).fill(0); edges = new Set([text.length]);
    for (const { index, segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) {
      edges.add(index);
      const width = WIDE.test(segment) || /[\uD800-\uDBFF\uFE0F]/.test(segment) ? 2 : 1;
      for (let k = 0; k < segment.length; k++) cols[index + k + 1] = cols[index + k]! + (k === 0 ? width : 0);
    }
  }
  const span = (from: number, to: number) => cols ? cols[to]! - cols[from]! : to - from;
  const whole = (i: number) => !edges || edges.has(i);
  const reach = (from: number, limit: number) => {
    if (!cols) return from + limit;
    let i = from;
    while (i < text.length && cols[i + 1]! - cols[from]! <= limit) i++;
    while (i > from + 1 && !whole(i)) i--;
    while (i < text.length && (i <= from || !whole(i))) i++;
    return i;
  };
  let start = 0;
  while (start < text.length) {
    const limit = Math.max(1, lines.length ? width : firstWidth);
    const hard = text.indexOf("\n", start);
    const end = hard >= 0 ? hard : text.length;
    if (span(start, end) <= limit) {
      lines.push([start, end]);
      if (hard < 0) break;
      start = hard + 1;
      if (start === text.length) lines.push([start, start]);
      continue;
    }
    let cut = -1, next = -1;
    // A hyphen just past the margin hangs there, ending the line (measured: Final Draft prints 62-character
    // action lines that end in a hyphen).
    const hang = reach(start, limit);
    if (text[hang] === "-" && text[hang - 1] !== " " && text[hang + 1] !== "-" && whole(hang + 1)) {
      cut = next = hang + 1;
    }
    for (let i = hang; i > start && cut < 0; i--) {
      if (cols && whole(i) && (WIDE.test(text[i - 1]!) || WIDE.test(text[i] ?? "")) && !NO_LINE_START.test(text[i] ?? "") && !NO_LINE_END.test(text[i - 1]!)) {
        cut = next = i;
        break;
      }
      if (text[i] === " " && whole(i + 1)) {
        cut = i;
        next = i;
        break;
      }
      // Final Draft also breaks after a hyphen inside a word (not after an em dash; measured).
      if (text[i - 1] === "-" && i - 1 > start && text[i - 2] !== " " && i < end && text[i] !== "-" && whole(i)) {
        cut = next = i;
        break;
      }
    }
    if (cut < 0) cut = next = hang;
    lines.push([start, cut]);
    start = next;
    while (text[start] === " ") start++;
  }
  if (!lines.length) lines.push([0, 0]);
  return lines;
}

/** Offsets just past each sentence end in text[from, to), with where the next sentence starts. */
function sentenceEnds(text: string, from: number, to: number): { end: number; next: number }[] {
  const ends: { end: number; next: number }[] = [];
  const pattern = /[.!?]+["'”’)\]]*(?=\s)/g;
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match && match.index < to; match = pattern.exec(text)) {
    const end = match.index + match[0].length;
    let next = end;
    while (next < to && /\s/.test(text[next]!)) next++;
    if (end > from && next < to) ends.push({ end, next });
  }
  return ends;
}

// ----- Printed text ---------------------------------------------------------------------------------------

/** A paragraph's text as printed, with a map from printed offsets back to the paragraph's own offsets. */
interface Printed {
  text: string;
  runs: Run[];
  /** source[i] is the paragraph offset of printed character i; source[text.length] is the paragraph's length. */
  source: number[];
}

/** Upper-case without changing the length, so offsets stay valid. */
function upper(text: string): string {
  const all = text.toUpperCase();
  if (all.length === text.length) return all;
  return [...text].map((char) => (char.toUpperCase().length === char.length ? char.toUpperCase() : char)).join("");
}

/**
 * Inline notes never print and take no room: leaving one out also drops the space it would leave doubled
 * ("one [[note]] two" prints "one two") and spaces it would leave at either end of the paragraph.
 */
function printed(paragraph: Paragraph, caps: boolean): Printed {
  const runs: Run[] = [];
  const source: number[] = [];
  let at = 0;
  let gap = false;
  let last = "";
  for (const run of paragraph.runs) {
    if (run.note) {
      gap = true;
      at += run.text.length;
      continue;
    }
    let text = caps || run.allCaps ? upper(run.text) : run.text;
    let skip = 0;
    if (gap) {
      while (skip < text.length && text[skip] === " " && (!source.length || last === " ")) skip++;
      gap = skip === text.length;
    }
    text = text.slice(skip);
    if (text) {
      runs.push({ ...run, text });
      for (let i = skip; i < run.text.length; i++) source.push(at + i);
      last = text.at(-1)!;
    }
    at += run.text.length;
  }
  if (gap) {
    while (runs.length && runs.at(-1)!.text.endsWith(" ")) {
      const run = runs.at(-1)!;
      run.text = run.text.slice(0, -1);
      source.pop();
      if (!run.text) runs.pop();
    }
  }
  source.push(at);
  return { text: runs.map((run) => run.text).join(""), runs, source };
}

/** A paragraph that holds only inline notes prints nothing, not even a blank line. */
function onlyNotes(paragraph: Paragraph): boolean {
  return paragraph.runs.some((run) => run.note) && paragraph.runs.every((run) => run.note || !run.text.trim());
}

function sliceRuns(runs: readonly Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const start = Math.max(from, at), end = Math.min(to, at + run.text.length);
    if (end > start) out.push({ ...run, text: run.text.slice(start - at, end - at) });
    at += run.text.length;
  }
  return out;
}

// ----- Groups ----------------------------------------------------------------------------------------------

type Role = "heading" | "speech" | "dual" | "action" | "transition" | "other";

/** A stretch of one paragraph's printed text, [from, to) in printed offsets. */
interface Piece {
  paragraph: Paragraph;
  element: ElementLayout;
  text: Printed;
  from: number;
  to: number;
  suffix?: string;
  column?: 1 | 2;
}

interface Group {
  role: Role;
  pieces: Piece[];
  /** Speech: the character cue, also when the group continues a speech and the cue is not among its pieces. */
  cue?: Piece;
  /** Starts with a generated "CHARACTER (CONT'D)" line. */
  contd?: boolean;
  /** Ends with a generated (MORE) line. */
  more?: boolean;
  keepWithNext: boolean;
  keepWithPrevious: boolean;
  newPage: boolean;
  /** Locked pages that start right before this group, as indexes into options.locks (paginateLocked). */
  locks?: number[];
}

/** A line laid out relative to the top of its group. */
type Draft = Omit<Line, "y"> & { dy: number; height: number };

interface Context {
  layout: Pagination["layout"];
  options: PaginationOptions;
  paginateAs(type: ElementType): ElementType;
  more: string;
  contd: string;
  dialogueBreaks: boolean;
  breakAtSentences: boolean;
  breakBefore: ReadonlySet<ElementType>;
  laid: WeakMap<Group, { drafts: Draft[]; height: number }>;
  element(type: ElementType): ElementLayout;
  /** Scene ID of each scene heading paragraph. */
  sceneIds: Map<string, string>;
}

/** Character name without extensions such as (V.O.) or (CONT'D), for matching speakers. */
function speakerName(text: string): string {
  return upper(text).replace(/\^\s*$/, "").replace(/\s*\([^)]*\)/g, "").trim();
}

function hasContd(text: string): boolean {
  return /\(\s*CONT['’]?D\s*\)|\(\s*CONTINUED\s*\)|\(\s*CONT\.?\s*\)/i.test(text);
}

/** Final Draft can store indents and spacing on a single paragraph; they win over the element's settings. */
function paragraphLayout(paragraph: Paragraph, element: ElementLayout, linesPerInch: number): ElementLayout {
  const attrs = paragraph.fdx?.attrs;
  const align = paragraph.alignment?.toLowerCase();
  if (!attrs && !align) return element;
  const out = { ...element };
  if (align === "center" || align === "right" || align === "left") out.align = align;
  const value = (name: string) => {
    const found = Number.parseFloat(attrs?.find(([key]) => key === name)?.[1] ?? "");
    return Number.isFinite(found) ? found : undefined;
  };
  const left = value("LeftIndent"), right = value("RightIndent"), first = value("FirstIndent");
  const before = value("SpaceBefore"), spacing = value("Spacing");
  if (left !== undefined && right !== undefined && right > left) Object.assign(out, { left, right });
  if (first !== undefined) out.firstIndent = first;
  if (before !== undefined) out.spaceBefore = before / (72 / linesPerInch);
  if (spacing !== undefined && spacing > 0) out.spacing = spacing;
  return out;
}

function makePiece(paragraph: Paragraph, ctx: Context, column?: 1 | 2): Piece {
  let element = paragraphLayout(paragraph, ctx.layout.elements[paragraph.type], ctx.layout.page.linesPerInch);
  if (column) element = dualElement(element, column);
  const text = printed(paragraph, element.caps);
  return { paragraph, element, text, from: 0, to: text.text.length, ...(column ? { column } : {}) };
}

/**
 * Dual dialogue squeezes the speech area (cue, parenthetical and dialogue indents) into a column 2.88" wide (29
 * characters of dialogue): the left one starts at the action margin, the right one at 4.61" (measured on Final
 * Draft 13's PDFs: both columns wrap at 29 characters and the right one starts 332 points from the edge).
 */
function dualElement(element: ElementLayout, column: 1 | 2): ElementLayout {
  const area = { left: 2.5, right: 6.0 };
  const width = 2.88;
  const origin = column === 1 ? 1.5 : 4.611;
  const scale = width / (area.right - area.left);
  const map = (x: number) => origin + (x - area.left) * scale;
  return { ...element, align: "left", left: map(element.left), right: Math.min(origin + width, map(element.right)) };
}

function role(type: ElementType): Role {
  switch (type) {
    case "sceneHeading": return "heading";
    case "action": return "action";
    case "transition": return "transition";
    default: return "other";
  }
}

function buildGroups(script: Script, ctx: Context): Group[] {
  const paragraphs = script.paragraphs.filter((paragraph) => !NON_PRINTING.has(paragraph.type) && !onlyNotes(paragraph));
  const groups: Group[] = [];
  const inSpeech = (paragraph: Paragraph | undefined) => {
    if (!paragraph || paragraph.dual || paragraph.startsNewPage) return false;
    const as = ctx.paginateAs(paragraph.type);
    return as === "dialogue" || as === "parenthetical";
  };
  let lastSpeaker: string | null = null;
  for (let i = 0; i < paragraphs.length; ) {
    const paragraph = paragraphs[i]!;
    const newPage = !!paragraph.startsNewPage;
    if (paragraph.dual) {
      const block = paragraph.dual.block;
      const pieces: Piece[] = [];
      for (; i < paragraphs.length && paragraphs[i]!.dual?.block === block; i++) {
        pieces.push(makePiece(paragraphs[i]!, ctx, paragraphs[i]!.dual!.side));
      }
      groups.push({ role: "dual", pieces, keepWithNext: false, keepWithPrevious: false, newPage });
      lastSpeaker = null;
      continue;
    }
    const as = ctx.paginateAs(paragraph.type);
    if (paragraph.type === "sceneHeading" || paragraph.type === "newAct") lastSpeaker = null;
    if (as === "character" && paragraph.type === "character" && inSpeech(paragraphs[i + 1])) {
      const cue = makePiece(paragraph, ctx);
      const name = speakerName(cue.text.text);
      if (ctx.options.autoContinueds !== false && name && name === lastSpeaker && !hasContd(cue.text.text)) {
        cue.suffix = ` ${ctx.element("character").caps ? upper(ctx.contd) : ctx.contd}`;
      }
      lastSpeaker = name;
      const pieces = [cue];
      for (i++; inSpeech(paragraphs[i]); i++) pieces.push(makePiece(paragraphs[i]!, ctx));
      groups.push({ role: "speech", pieces, cue, keepWithNext: false, keepWithPrevious: false, newPage });
      continue;
    }
    const kind = role(as);
    groups.push({
      role: kind, pieces: [makePiece(paragraph, ctx)],
      keepWithNext: kind === "heading", keepWithPrevious: kind === "transition", newPage,
    });
    i++;
  }
  return groups;
}

// ----- Laying out a group ----------------------------------------------------------------------------------

function pieceRanges(piece: Piece, ctx: Context): [number, number][] {
  const cpi = ctx.layout.page.charsPerInch;
  const { element } = piece;
  const width = columns(element.right - element.left, cpi);
  // The hanging first indent applies only to the paragraph's real first line.
  const first = piece.from === 0 ? columns(element.right - element.left - (element.firstIndent ?? 0), cpi) : width;
  return wrapLines(piece.text.text.slice(piece.from, piece.to), first, width)
    .map(([from, to]) => [from + piece.from, to + piece.from] as [number, number]);
}

function lineCount(piece: Piece, ctx: Context): number {
  return pieceRanges(piece, ctx).length;
}

/**
 * Characters Courier Final Draft has no glyph for. Final Draft draws them from a fallback font whose taller line
 * makes that printed line 16 points instead of 12 (measured: lines holding a euro or trademark sign sit 2 points
 * lower and push every later line down 4 points).
 */
const FALLBACK_GLYPHS = /[\u20AC\u2122]/;
/** Measured in Cold Open's system-font PDF: CJK, Indic and Thai glyphs and emoji (including symbols drawn as emoji by U+FE0F) rise above a 12-point line and touch the cue above. */
const TALL_SCRIPTS = /[\u0900-\u0DFF\u0E00-\u0E7F\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60\uD83C-\uD83E\uFE0F]/;
const TALL_LINE = 16 / 12;

function pieceDrafts(piece: Piece, ctx: Context, top: number): Draft[] {
  const { element, text, paragraph } = piece;
  const cpi = ctx.layout.page.charsPerInch;
  const spacing = element.spacing ?? 1;
  const ranges = pieceRanges(piece, ctx);
  let dy = top;
  return ranges.map(([from, to], index) => {
    const line = text.text.slice(from, to), tall = FALLBACK_GLYPHS.test(line) || TALL_SCRIPTS.test(line), height = spacing * (tall ? TALL_LINE : 1);
    const suffix = index === ranges.length - 1 ? piece.suffix : undefined;
    let end = to;
    if (suffix) while (end > from && text.text[end - 1] === " ") end--;
    const runs = sliceRuns(text.runs, from, end);
    if (suffix) runs.push({ text: suffix });
    const chars = end - from + (suffix?.length ?? 0);
    const left = element.left + (from === 0 ? element.firstIndent ?? 0 : 0);
    const x = element.align === "right" ? element.right - chars / cpi
      : element.align === "center" ? (left + element.right - chars / cpi) / 2 : left;
    const draft: Draft = {
      paragraphId: paragraph.id, type: paragraph.type, runs, x, dy, height,
      from: text.source[from]!, to: to > from ? text.source[to - 1]! + 1 : text.source[from]!,
      ...(piece.column ? { column: piece.column } : {}),
      ...(suffix ? { suffix } : {}),
      ...(tall ? { tall: true as const } : {}),
    };
    dy += height;
    return draft;
  });
}

function generatedDraft(cue: Piece, text: string, kind: "more" | "contd", dy: number): Draft {
  return {
    paragraphId: cue.paragraph.id, type: "character", from: 0, to: 0,
    runs: [{ text }], x: cue.element.left, dy, height: 1, generated: kind,
  };
}

function contdText(cue: Piece, ctx: Context): string {
  const name = cue.text.text.replace(/\s*\(\s*CONT['’]?D\s*\)\s*$/i, "").trim();
  return `${name} ${cue.element.caps ? upper(ctx.contd) : ctx.contd}`;
}

function layoutGroup(group: Group, ctx: Context): { drafts: Draft[]; height: number } {
  const cached = ctx.laid.get(group);
  if (cached) return cached;
  const drafts: Draft[] = [];
  let height = 0;
  if (group.role === "dual") {
    for (const column of [1, 2] as const) {
      let y = 0;
      group.pieces.filter((piece) => piece.column === column).forEach((piece, index) => {
        if (index) y += piece.element.spaceBefore;
        const lines = pieceDrafts(piece, ctx, y);
        drafts.push(...lines);
        y += lines.reduce((sum, line) => sum + line.height, 0);
      });
      height = Math.max(height, y);
    }
    // Row order, so a block taller than a page carries both columns on to the next page at the same row.
    drafts.sort((a, b) => a.dy - b.dy || (a.column ?? 0) - (b.column ?? 0));
  } else {
    let y = 0;
    if (group.contd && group.cue) {
      // Final Draft prints CHARACTER (CONT'D) on the line above the top margin, so it takes no line of the page.
      drafts.push(generatedDraft(group.cue, contdText(group.cue, ctx), "contd", -1));
    }
    group.pieces.forEach((piece, index) => {
      if (index) y += piece.element.spaceBefore;
      const lines = pieceDrafts(piece, ctx, y);
      drafts.push(...lines);
      y += lines.reduce((sum, line) => sum + line.height, 0);
    });
    if (group.more && group.cue) {
      drafts.push(generatedDraft(group.cue, ctx.more, "more", y));
      y += 1;
    }
    height = y;
  }
  const result = { drafts, height };
  ctx.laid.set(group, result);
  return result;
}

function spaceBefore(group: Group): number {
  return group.contd ? 0 : group.pieces[0]?.element.spaceBefore ?? 0;
}

// ----- Breaking a group ------------------------------------------------------------------------------------

/** Places a paragraph may break: [end of the first part, start of the second], in printed offsets. */
function breakPoints(piece: Piece, ctx: Context): { end: number; next: number }[] {
  if (ctx.breakAtSentences) return sentenceEnds(piece.text.text, piece.from, piece.to);
  return pieceRanges(piece, ctx).slice(0, -1).map(([, to], index, ranges) => ({ end: to, next: ranges[index + 1]?.[0] ?? to }))
    .filter((point) => point.end > piece.from);
}

/**
 * Ways to split a piece at a break point. Lines are counted on the paragraph as it wraps unbroken: Final Draft
 * wants `before` lines up to and including the line where the sentence ends, and `after` whole lines below it.
 * (Counting the re-wrapped halves instead lets a three-line paragraph break 2 + 2, which Final Draft never does.)
 */
function pieceSplits(piece: Piece, ctx: Context, before: number, after: number): [Piece, Piece][] {
  const splits: [Piece, Piece][] = [];
  const ranges = pieceRanges(piece, ctx);
  for (const { end, next } of breakPoints(piece, ctx)) {
    const line = ranges.findIndex(([, to]) => end - 1 < to);
    if (line + 1 < before || ranges.length - line - 1 < after) continue;
    const head = { ...piece, to: end }, tail = { ...piece, from: next };
    delete head.suffix;
    splits.push([head, tail]);
  }
  return splits;
}

function lines(pieces: readonly Piece[], ctx: Context): number {
  return pieces.reduce((sum, piece) => sum + lineCount(piece, ctx), 0);
}

function splitOptions(group: Group, ctx: Context): { first: Group; rest: Group }[] {
  const options: { first: Group; rest: Group }[] = [];
  const base = { keepWithNext: false, keepWithPrevious: false, newPage: false };
  if (group.role === "action") {
    for (const [head, tail] of pieceSplits(group.pieces[0]!, ctx, MIN_LINES, MIN_LINES)) {
      options.push({
        first: { ...base, role: "action", pieces: [head], keepWithPrevious: group.keepWithPrevious, newPage: group.newPage },
        rest: { ...base, role: "action", pieces: [tail], keepWithNext: group.keepWithNext },
      });
    }
  }
  if (group.role === "speech" && group.cue) {
    // A speech breaks between its paragraphs or at a sentence end inside dialogue. Each side keeps two lines
    // of the speech (parentheticals count) besides the cue, and the cue never ends a page alone.
    const markers = ctx.dialogueBreaks;
    const first = (pieces: Piece[]): Group => ({
      ...base, role: "speech", pieces, cue: group.cue!, newPage: group.newPage,
      ...(group.contd ? { contd: true } : {}), ...(markers ? { more: true } : {}),
    });
    const rest = (pieces: Piece[]): Group => ({ ...base, role: "speech", pieces, cue: group.cue!, ...(markers ? { contd: true } : {}) });
    const pieces = group.pieces;
    // The cue leads the speech's first part only; a later part (after a break, with or without CONT'D) has none.
    const body = pieces[0] === group.cue ? 1 : 0;
    for (let j = body; j < pieces.length; j++) {
      const piece = pieces[j]!;
      const as = ctx.paginateAs(piece.paragraph.type);
      const prior = lines(pieces.slice(body, j), ctx);
      const later = lines(pieces.slice(j + 1), ctx);
      const spoken = pieces.slice(body, j).some((p) => ctx.paginateAs(p.paragraph.type) === "dialogue");
      // After a dialogue paragraph, or after a parenthetical once some dialogue has printed (measured: Final
      // Draft will end a page on "(beat)" + (MORE) mid-speech).
      const boundary = j < pieces.length - 1 && prior + lineCount(piece, ctx) >= MIN_LINES && later >= MIN_LINES
        && (as === "dialogue" || (as === "parenthetical" && spoken));
      if (boundary) options.push({ first: first(pieces.slice(0, j + 1)), rest: rest(pieces.slice(j + 1)) });
      if (as !== "dialogue") continue;
      for (const [head, tail] of pieceSplits(piece, ctx, Math.max(1, MIN_LINES - prior), Math.max(1, MIN_LINES - later))) {
        options.push({ first: first([...pieces.slice(0, j), head]), rest: rest([tail, ...pieces.slice(j + 1)]) });
      }
    }
  }
  return options;
}

// ----- Pages -----------------------------------------------------------------------------------------------

function chainHeight(chain: readonly Group[], atTop: boolean, ctx: Context): number {
  return chain.reduce((sum, group, index) => sum + (index === 0 && atTop ? 0 : spaceBefore(group)) + layoutGroup(group, ctx).height, 0);
}

/** Groups that must share a page: a heading with what follows it, a transition with what precedes it. */
function chains(groups: readonly Group[]): Group[][] {
  const out: Group[][] = [];
  for (const group of groups) {
    const chain = out.at(-1);
    const last = chain?.at(-1);
    // A heading followed by another heading may end a page: Final Draft breaks a run of headings between them.
    const keep = last?.keepWithNext && group.role !== "heading";
    if (chain && last && !group.newPage && !group.locks && (keep || group.keepWithPrevious)) chain.push(group);
    else out.push([group]);
  }
  return out;
}

function splitCandidates(chain: readonly Group[], ctx: Context): { first: Group[]; rest: Group[] }[] {
  const candidates: { first: Group[]; rest: Group[] }[] = [];
  chain.forEach((group, i) => {
    const next = chain[i + 1];
    if (next && !group.keepWithNext && !next.keepWithPrevious) {
      candidates.push({ first: chain.slice(0, i + 1), rest: chain.slice(i + 1) });
    }
    for (const option of splitOptions(group, ctx)) {
      candidates.push({ first: [...chain.slice(0, i), option.first], rest: [option.rest, ...chain.slice(i + 1)] });
    }
  });
  return candidates;
}

/** A new page's printed number; `added` marks an A-page after a locked page. */
interface PageLabel {
  number: string;
  added?: true;
}

class Pager {
  readonly pages: Page[] = [];
  readonly positions = new Map<string, { page: number; line: number }>();
  y = 0;
  /** No script text on the page yet, so the next element drops its space before. */
  fresh = true;
  private sceneOpen = false;
  readonly capacity: number;
  private readonly ctx: Context;
  /** Numbers a page the text runs onto: 1, 2, 3, or with locked pages an A-page. */
  private readonly label: () => PageLabel;

  constructor(ctx: Context, label?: (pages: readonly Page[]) => PageLabel) {
    this.ctx = ctx;
    this.label = label ? () => label(this.pages) : () => ({ number: String(this.pages.length + 1) });
    const full = linesPerPage(ctx.layout.page);
    this.capacity = ctx.options.sceneContinueds ? full - 2 : full;
    this.addPage();
  }

  private addPage(label = this.label()): void {
    this.pages.push({ number: label.number, lines: [], sceneIds: [], ...(label.added ? { added: true as const } : {}) });
    this.y = 0;
    this.fresh = true;
  }

  get page(): Page {
    return this.pages.at(-1)!;
  }

  /** Start a new page before `next`; with scene continueds, mark a scene that runs on. */
  newPage(next?: Group, label?: PageLabel): void {
    const continues = this.ctx.options.sceneContinueds && this.sceneOpen && !this.fresh
      && !(next?.role === "heading" && next.pieces[0]?.paragraph.type === "sceneHeading");
    const ctx = this.ctx;
    if (continues) {
      const bottom = upper(ctx.options.sceneBottom ?? "(CONTINUED)");
      const transition = ctx.layout.elements.transition;
      this.page.lines.push({ paragraphId: "", type: "transition", from: 0, to: 0, runs: [{ text: bottom }], generated: "more",
        x: transition.right - bottom.length / ctx.layout.page.charsPerInch, y: this.capacity + 1 });
    }
    this.addPage(label);
    if (continues) {
      const top = upper(ctx.options.sceneTop ?? "CONTINUED:");
      this.page.lines.push({ paragraphId: "", type: "action", from: 0, to: 0, runs: [{ text: top }], generated: "contd",
        x: ctx.layout.elements.action.left, y: 0 });
      this.y = 2;
    }
  }

  fits(height: number): boolean {
    return this.y + height <= this.capacity + EPSILON;
  }

  /** Put groups on the current page. Lines that run past the foot (only for a group taller than a page) carry on. */
  emit(groups: readonly Group[]): void {
    for (const group of groups) {
      const top = this.y + (this.fresh ? 0 : spaceBefore(group));
      let base = top;
      for (const draft of layoutGroup(group, this.ctx).drafts) {
        let y = base + draft.dy;
        // (MORE) may print on the line below the bottom margin, as Final Draft's does.
        const room = this.capacity + (draft.generated === "more" ? 1 : 0);
        if (y + draft.height > room + EPSILON && !(this.fresh && y === this.y)) {
          this.newPage();
          base = this.y - draft.dy;
          y = this.y;
        }
        this.place(draft, y);
      }
      this.y = Math.max(this.y, base + layoutGroup(group, this.ctx).height);
    }
  }

  private place(draft: Draft, y: number): void {
    const { dy: _dy, height: _height, ...line } = draft;
    this.page.lines.push({ ...line, y });
    this.fresh = false;
    if (draft.generated) return;
    if (!this.positions.has(draft.paragraphId)) this.positions.set(draft.paragraphId, { page: this.pages.length - 1, line: y });
    if (draft.type === "sceneHeading" && draft.from === 0) {
      this.sceneOpen = true;
      const paragraph = draft.paragraphId;
      const sceneId = this.ctx.sceneIds.get(paragraph) ?? paragraph;
      if (!this.page.sceneIds.includes(sceneId)) this.page.sceneIds.push(sceneId);
    }
  }
}

export function paginate(script: Script, options: PaginationOptions = {}): Pagination {
  // A template's page rules belong to the script, so every caller gets them, not only printing.
  const breaks = options.breakBefore === undefined ? templateBreakBefore(script.template) : [];
  const resolved = breaks.length ? { ...options, breakBefore: breaks } : options;
  return resolved.locks?.length ? paginateLocked(script, resolved, resolved.locks) : paginateFlow(script, resolved);
}

function context(script: Script, options: PaginationOptions): Context {
  const layout = resolveLayout(options);
  return {
    layout, options,
    paginateAs: (type) => options.paginateAs?.[type] ?? DEFAULT_PAGINATE_AS[type] ?? type,
    element: (type) => layout.elements[type],
    more: options.more ?? "(MORE)",
    contd: options.contd ?? "(CONT'D)",
    dialogueBreaks: options.dialogueBreaks !== false,
    breakAtSentences: options.breakAtSentences !== false,
    breakBefore: new Set(options.breakBefore ?? []),
    laid: new WeakMap(),
    sceneIds: new Map(script.paragraphs.filter((p) => p.type === "sceneHeading").map((p) => [p.id, p.sceneId ?? p.id])),
  };
}

/** (MORE) sits below the bottom margin, so a part ending in it needs one line less room on the page. */
const moreLine = (groups: readonly Group[]) => (groups.at(-1)?.more ? 1 : 0);

/** Lay a chain onto pages from where the pager is: whole if it fits, else split where it fills the page most. */
function placeChain(pager: Pager, chain: Group[], ctx: Context): void {
  for (;;) {
    if (pager.fits(chainHeight(chain, pager.fresh, ctx) - moreLine(chain))) {
      pager.emit(chain);
      return;
    }
    let best: { first: Group[]; rest: Group[]; height: number } | undefined;
    for (const candidate of splitCandidates(chain, ctx)) {
      const height = chainHeight(candidate.first, pager.fresh, ctx);
      if (pager.fits(height - moreLine(candidate.first)) && (!best || height >= best.height)) best = { ...candidate, height };
    }
    if (best) {
      pager.emit(best.first);
      pager.newPage(best.rest[0]);
      chain = best.rest;
    } else if (!pager.fresh) {
      pager.newPage(chain[0]);
    } else {
      // Taller than a page with nowhere Final Draft would break it: run it on line by line.
      pager.emit(chain);
      return;
    }
  }
}

/** A chain starts a new page when its first paragraph asks for one or the template breaks before its element. */
function startsNewPage(chain: readonly Group[], ctx: Context, previous?: ElementType): boolean {
  const group = chain[0];
  const type = group?.pieces[0]?.paragraph.type;
  if (!group) return false;
  if (group.newPage) return true;
  // An act heading and the scene heading under it stay on one page, as they do in Final Draft's templates.
  if (type === "sceneHeading" && previous === "newAct") return false;
  return type !== undefined && ctx.breakBefore.has(type);
}

/** The element a chain ends with, for the next chain's page-break rule. */
function lastElementType(chain: readonly Group[]): ElementType | undefined {
  return chain.at(-1)?.pieces.at(-1)?.paragraph.type;
}

function paginateFlow(script: Script, options: PaginationOptions): Pagination {
  const ctx = context(script, options);
  const pager = new Pager(ctx);
  let previous: ElementType | undefined;
  for (const chain of chains(buildGroups(script, ctx))) {
    if (startsNewPage(chain, ctx, previous) && !pager.fresh) pager.newPage(chain[0]);
    placeChain(pager, chain, ctx);
    previous = lastElementType(chain);
  }
  return { pages: pager.pages, layout: ctx.layout, positions: pager.positions };
}

// ----- Locked pages ----------------------------------------------------------------------------------------

const NUMBER = /^([A-Z]*)(\d+)([A-Z]*)$/i;

function nextLetters(letters: string): string {
  if (!letters) return "A";
  const last = letters.at(-1)!.toUpperCase();
  return last === "Z" ? `${letters}A` : letters.slice(0, -1) + String.fromCharCode(last.charCodeAt(0) + 1);
}

function compareLetters(a: string, b: string): number {
  const x = a.toUpperCase(), y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Order of page or scene numbers: by the number, then letters before it ("A1" and "B1" come before "1"), then
 * letters after it ("12" < "12A" < "12AA" < "12B" < "13"). Anything else compares as text with numbers in it.
 */
export function compareNumbers(a: string, b: string): number {
  const x = NUMBER.exec(a.trim()), y = NUMBER.exec(b.trim());
  if (!x || !y) return a.localeCompare(b, undefined, { numeric: true });
  const prefix = !x[1] && y[1] ? 1 : x[1] && !y[1] ? -1 : compareLetters(x[1]!, y[1]!);
  return Number(x[2]) - Number(y[2]) || prefix || compareLetters(x[3]!, y[3]!);
}

/**
 * A number for something inserted between two locked numbers (an A-page or an A-scene): after 12 it is 12A,
 * after 12A it is 12B, between 12A and 12B it is 12AA, before 1 it is A1. Between 12 and 12A no letter sorts in
 * between, so it is 12AA, which is what productions use. Never one of `used`.
 */
export function numberBetween(previous: string | undefined, next: string | undefined, used: ReadonlySet<string> = new Set()): string {
  const taken = (candidate: string) => used.has(candidate) || candidate === next || candidate === previous;
  if (previous === undefined) {
    if (next === undefined) {
      let n = 1;
      while (taken(String(n))) n++;
      return String(n);
    }
    const match = NUMBER.exec(next);
    const base = match ? match[2]! + match[3]! : next;
    let letters = "A";
    for (let i = 0; i < 100; i++, letters = nextLetters(letters)) {
      const candidate = letters + base;
      if (!taken(candidate) && (!match || compareNumbers(candidate, next) < 0)) return candidate;
    }
    return `A${next}`;
  }
  const match = NUMBER.exec(previous);
  const candidates: string[] = [];
  const nextMatch = next !== undefined ? NUMBER.exec(next) : null;
  // A1 is followed by B1 while scene 1 comes next.
  if (match?.[1] && !match[3] && nextMatch && !nextMatch[1] && nextMatch[2] === match[2]) candidates.push(nextLetters(match[1]) + match[2]);
  if (match?.[3]) candidates.push(match[1]! + match[2]! + nextLetters(match[3]));
  for (let suffix = "A"; suffix.length < 6; suffix += "A") candidates.push(previous + suffix);
  const fits = (candidate: string) => !taken(candidate) && compareNumbers(candidate, previous) > 0
    && (next === undefined || compareNumbers(candidate, next) < 0);
  return candidates.find(fits) ?? candidates.find((candidate) => !taken(candidate)) ?? `${previous}A`;
}

const textLength = (paragraph: Paragraph) => paragraph.runs.reduce((sum, run) => sum + run.text.length, 0);

/** Where a locked page starts: a paragraph index into the script and a character offset in that paragraph. */
type Point = { i: number; o: number };

/** The first printed character at or after a paragraph offset, as an offset into a piece's printed text. */
function printedAt(piece: Piece, offset: number): number {
  const source = piece.text.source;
  let low = 0, high = source.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (source[mid]! < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Where a locked page that starts at a printed offset inside a piece starts printing: never inside a word.
 * Deleting a locked page's first characters, or the space before them, can leave its start inside a word; the
 * page then starts with the whole word. Where a line may wrap (at a space, after a hyphen, or where the flow
 * breaks a word too long for a line) the start is kept.
 */
function wordStart(piece: Piece, cut: number, ctx: Context): number {
  const text = piece.text.text;
  const inWord = (i: number) => !/\s/.test(text[i - 1]!) && text[i - 1] !== "-" && !/\s/.test(text[i]!);
  if (!inWord(cut) || pieceRanges(piece, ctx).some(([from]) => from === cut)) return cut;
  let start = cut;
  while (start > piece.from && inWord(start)) start--;
  return start;
}

/**
 * Cut a group where a locked page starts. "before" and "after" mean the page starts at the group's first line or
 * just past its last. Otherwise the cut is the same one the flow makes when it breaks a page there (a speech gets
 * (MORE) and CHARACTER (CONT'D)), or, where the flow would not break, a plain cut at that line: a group taller
 * than a page runs on line by line, and so does text the writer changed around a lock.
 */
function cutGroup(group: Group, point: Point, at: Map<Paragraph, number>, ctx: Context): "before" | "after" | { first: Group; rest: Group } {
  const index = (piece: Piece) => at.get(piece.paragraph)!;
  if (point.i < index(group.pieces[0]!)) return "before";
  if (group.role === "dual") return cutRows(group, point, at, ctx);
  let j = group.pieces.findIndex((piece) => index(piece) >= point.i);
  if (j < 0) return "after";
  let cut = group.pieces[j]!.from;
  if (index(group.pieces[j]!) === point.i) {
    const piece = group.pieces[j]!;
    let printed = printedAt(piece, point.o);
    if (printed > piece.from && printed < piece.to) printed = wordStart(piece, printed, ctx);
    if (printed > piece.from && printed < piece.to) cut = printed;
    else if (printed > piece.from) {
      j++;
      cut = group.pieces[j]?.from ?? 0;
    }
  }
  if (j >= group.pieces.length) return "after";
  const piece = group.pieces[j]!;
  const atStart = cut === piece.from;
  // Never a cue alone at the foot of a page: the page starts with the cue instead.
  if (atStart && (j === 0 || group.pieces[j - 1] === group.cue)) return "before";

  const same = splitOptions(group, ctx).find(({ rest }) => rest.pieces[0]!.paragraph === piece.paragraph && rest.pieces[0]!.from === cut);
  if (same) return same;

  const text = piece.text.text;
  let end = cut;
  while (end > piece.from && /\s/.test(text[end - 1]!)) end--;
  const head = atStart ? [] : [{ ...piece, to: end }];
  for (const part of head) delete part.suffix;
  const tail = atStart ? [] : [{ ...piece, from: cut }];
  const before = [...group.pieces.slice(0, j), ...head];
  const after = [...tail, ...group.pieces.slice(atStart ? j : j + 1)];
  if (!before.length) return "before";
  // A speech broken between its paragraphs or at a sentence keeps its (MORE) and CONT'D, as Final Draft prints it.
  const spoken = (pieces: readonly Piece[]) => pieces.some((p) => p !== group.cue && ctx.paginateAs(p.paragraph.type) === "dialogue");
  const sentence = !atStart && breakPoints(piece, ctx).some((stop) => stop.next === cut);
  const markers = group.role === "speech" && ctx.dialogueBreaks && (atStart ? spoken(group.pieces.slice(0, j)) : sentence);
  const base = { role: group.role, keepWithNext: false, keepWithPrevious: false, newPage: false, ...(group.cue ? { cue: group.cue } : {}) };
  return {
    first: {
      ...base, pieces: before, keepWithPrevious: group.keepWithPrevious, newPage: group.newPage,
      ...(group.contd ? { contd: true } : {}), ...(markers ? { more: true } : {}),
    },
    rest: { ...base, pieces: after, keepWithNext: group.keepWithNext, ...(markers ? { contd: true } : {}) },
  };
}

/**
 * Cut a dual-dialogue block where a locked page starts: at the line the lock points at, in row order. Both
 * columns carry on from that row, as they do when the flow runs a block over a page.
 */
function cutRows(group: Group, point: Point, at: Map<Paragraph, number>, ctx: Context): "before" | "after" | { first: Group; rest: Group } {
  const target = group.pieces.find((piece) => at.get(piece.paragraph) === point.i)?.paragraph;
  const { drafts, height } = layoutGroup(group, ctx);
  if (!target) return point.i < at.get(group.pieces[0]!.paragraph)! ? "before" : "after";
  const lines = drafts.filter((draft) => draft.paragraphId === target.id && !draft.generated);
  const line = lines.filter((draft) => draft.from <= point.o).at(-1) ?? lines[0];
  if (!line) return "after";
  // The flow places the block's lines in row order and starts the next page at the first line that does not fit,
  // so that line and every line after it in row order go over. Columns spaced differently have lines at the same
  // height that differ in size: the one before still fits and stays.
  const index = drafts.indexOf(line);
  if (index <= 0) return "before";
  const row = line.dy;
  const above = drafts.slice(0, index);
  const below = drafts.slice(index).map((draft) => ({ ...draft, dy: draft.dy - row }));
  const first: Group = { role: "dual", pieces: group.pieces, keepWithNext: false, keepWithPrevious: group.keepWithPrevious, newPage: group.newPage };
  const rest: Group = { role: "dual", pieces: group.pieces, keepWithNext: group.keepWithNext, keepWithPrevious: false, newPage: false };
  ctx.laid.set(first, { drafts: above, height: Math.max(...above.map((draft) => draft.dy + draft.height)) });
  ctx.laid.set(rest, { drafts: below, height: height - row });
  return { first, rest };
}

/**
 * Pagination with locked pages. The script is laid out in one pass, exactly as without locks, except that each
 * locked page starts a new page at the paragraph and offset where it started when it was locked (inside a
 * dual-dialogue block, at that row). Pages the text runs onto between two locked pages get A-numbers. A locked
 * page with nothing left between it and the next locked page vanishes and its number joins the page before
 * (12-13), or the page after when it was the first page. With no text changed, this is the unlocked pagination,
 * line for line: (MORE) and CONT'D, scene continueds and automatic (CONT'D)s included.
 */
function paginateLocked(script: Script, options: PaginationOptions, locks: readonly PageLock[]): Pagination {
  const paragraphs = script.paragraphs;
  const ctx = context(script, options);
  const groups = buildGroups(script, ctx);
  const at = new Map<Paragraph, number>();
  const index = new Map<string, number>();
  paragraphs.forEach((paragraph, i) => {
    at.set(paragraph, i);
    if (!index.has(paragraph.id)) index.set(paragraph.id, i);
  });
  const printing = new Set(groups.flatMap((group) => group.pieces.map((piece) => piece.paragraph)));

  const points: (Point | null)[] = locks.map((lock, k) => {
    if (k === 0) return { i: 0, o: 0 };
    let i = index.get(lock.paragraphId), o = lock.offset;
    if (i === undefined) {
      o = 0;
      i = (lock.paragraphIds ?? []).map((id) => index.get(id)).find((found) => found !== undefined);
    }
    if (i === undefined) return null;
    o = Math.max(0, Math.min(o, textLength(paragraphs[i]!)));
    if (o > 0 && o === textLength(paragraphs[i]!)) {
      i++;
      o = 0;
    }
    // A page starts at printed text: past a synopsis or note the lock now sits on.
    while (i < paragraphs.length && !printing.has(paragraphs[i]!)) {
      i++;
      o = 0;
    }
    return { i, o };
  });
  // A lock that now sits before the one above it (its text moved up) is treated as vanished. Inside one
  // dual-dialogue block pages run by row, so a page may start back in the left column after one that started in
  // the right: there order is left to the cut, which finds each page's row.
  const dualOf = new Map<Paragraph, Group>();
  for (const group of groups) if (group.role === "dual") for (const piece of group.pieces) dualOf.set(piece.paragraph, group);
  const sameDual = (a: Point, b: Point) => {
    const block = a.i >= 0 && paragraphs[a.i] ? dualOf.get(paragraphs[a.i]!) : undefined;
    return block !== undefined && b.i >= 0 && !!paragraphs[b.i] && dualOf.get(paragraphs[b.i]!) === block;
  };
  let last: Point = { i: -1, o: 0 };
  points.forEach((point, k) => {
    if (point && (point.i > last.i || (point.i === last.i && point.o >= last.o) || sameDual(point, last))) last = point;
    else points[k] = null;
  });

  // Cut the groups where locked pages start. Points are in script order, and so are the groups.
  const cut: Group[] = [];
  let g = 0;
  points.forEach((point, k) => {
    if (!point) return;
    for (;;) {
      const group = groups[g];
      if (!group) return;
      const result = cutGroup(group, point, at, ctx);
      if (result === "after") {
        cut.push(group);
        g++;
        continue;
      }
      if (result === "before") (group.locks ??= []).push(k);
      else {
        // A group cut twice (a speech over three locked pages) keeps the lock its first part starts.
        if (group.locks) result.first.locks = group.locks;
        cut.push(result.first);
        (result.rest.locks ??= []).push(k);
        groups[g] = result.rest;
      }
      return;
    }
  });
  cut.push(...groups.slice(g));

  const used = new Set(locks.map((lock) => lock.number));
  // The lock whose page was started last.
  let current = -1;
  let pendingFirst: string | undefined;
  const nextLocked = () => locks.find((_, j) => j > current && points[j] !== null)?.number;
  const pager = new Pager(ctx, (pages) => {
    if (!pages.length) return { number: locks[0]?.number ?? "1" };
    const number = numberBetween(pages.at(-1)!.number.split("-").at(-1), nextLocked(), used);
    used.add(number);
    return { number, added: true };
  });
  const vanish = (number: string, into: Page | undefined) => {
    if (into) into.number = `${into.number.split("-")[0]}-${number}`;
    else pendingFirst ??= number;
  };
  const take = (number: string) => {
    const label = pendingFirst !== undefined ? `${pendingFirst}-${number}` : number;
    pendingFirst = undefined;
    return label;
  };
  /**
   * Before lock k's page starts: the current lock's page vanishes when nothing landed on it (pages the text runs
   * onto always get text), and so do the locks in between, which were not found. Returns the empty page to reuse.
   */
  const settle = (k: number): Page | undefined => {
    const page = pager.page;
    const empty = !page.lines.some((line) => !line.generated);
    if (empty && current >= 0) vanish(locks[current]!.number, pager.pages.at(-2));
    for (let j = current + 1; j < k; j++) vanish(locks[j]!.number, empty ? pager.pages.at(-2) : page);
    return empty ? page : undefined;
  };

  let previous: ElementType | undefined;
  for (const chain of chains(cut)) {
    const head = chain[0]!;
    for (const k of head.locks ?? []) {
      const reuse = settle(k);
      if (reuse) {
        reuse.number = take(locks[k]!.number);
        delete reuse.added;
      } else {
        pager.newPage(head, { number: take(locks[k]!.number) });
      }
      current = k;
    }
    if (!head.locks && startsNewPage(chain, ctx, previous) && !pager.fresh) pager.newPage(head);
    placeChain(pager, chain, ctx);
    previous = lastElementType(chain);
  }
  if (current >= 0) settle(locks.length);
  return { pages: pager.pages, layout: ctx.layout, positions: pager.positions };
}

/** Page count, as printed. */
export function pageCount(pagination: Pagination): number {
  return pagination.pages.length;
}

/** Index into pagination.pages of the page holding a paragraph's first line, or -1 when it does not print. */
export function pageOf(pagination: Pagination, paragraphId: string): number {
  return pagination.positions.get(paragraphId)?.page ?? -1;
}

/**
 * The length of each scene in eighths of a page, the unit schedules use: the share of each page from the
 * scene's first line to the next scene's. A scene shorter than an eighth counts as one eighth.
 */
export function sceneEighths(script: Script, pagination: Pagination): Map<string, number> {
  const perPage = linesPerPage(pagination.layout.page);
  const sceneOf = new Map<string, string>();
  let current: string | undefined;
  for (const paragraph of script.paragraphs) {
    if (paragraph.type === "sceneHeading") current = paragraph.sceneId ?? paragraph.id;
    if (current) sceneOf.set(paragraph.id, current);
  }
  const extent = new Map<string, number>();
  for (const page of pagination.pages) {
    const starts: { scene: string; y: number }[] = [];
    let bottom = 0;
    for (const line of page.lines) {
      const scene = sceneOf.get(line.paragraphId);
      if (!scene) continue;
      if (starts.at(-1)?.scene !== scene) starts.push({ scene, y: line.y });
      bottom = Math.max(bottom, line.y + 1);
    }
    starts.forEach(({ scene, y }, index) => {
      const end = starts[index + 1]?.y ?? bottom;
      extent.set(scene, (extent.get(scene) ?? 0) + Math.max(0, end - y));
    });
  }
  const eighths = new Map<string, number>();
  for (const [scene, lines] of extent) eighths.set(scene, Math.max(1, Math.round((lines / perPage) * 8)));
  return eighths;
}

/** "1 3/8" style display of eighths. */
export function formatEighths(eighths: number): string {
  const whole = Math.floor(eighths / 8), rest = eighths % 8;
  if (!rest) return String(whole);
  return whole ? `${whole} ${rest}/8` : `${rest}/8`;
}

// ----- FDX layout ------------------------------------------------------------------------------------------

const FDX_ELEMENT_TYPES: Record<string, ElementType> = {
  "Scene Heading": "sceneHeading", "Action": "action", "Character": "character", "Parenthetical": "parenthetical",
  "Dialogue": "dialogue", "Transition": "transition", "Shot": "shot", "General": "general", "Lyrics": "lyrics",
  "Cast List": "castList", "New Act": "newAct", "End of Act": "endOfAct",
};

function children(node: XmlNode, name?: string): XmlNode[] {
  return node.children.filter((child): child is XmlNode => typeof child !== "string" && (!name || child.name === name));
}

function attribute(node: XmlNode | undefined, name: string): string | undefined {
  return node?.attrs.find(([key]) => key === name)?.[1];
}

function number(node: XmlNode | undefined, name: string): number | undefined {
  const value = Number.parseFloat(attribute(node, name) ?? "");
  return Number.isFinite(value) ? value : undefined;
}

function yes(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return /^(yes|true|1)$/i.test(value);
}

/** Find elements by name at the top level of the FDX extras and one level down. */
function fdxNodes(script: Script, name: string): XmlNode[] {
  const top = [...(script.fdx?.before ?? []), ...(script.fdx?.after ?? [])];
  return [...top.filter((node) => node.name === name), ...top.flatMap((node) => children(node, name))];
}

/**
 * Pagination options from an FDX file's own layout: ElementSettings (indents, space before, line spacing,
 * capitals, PaginateAs), PageLayout margins, and the MORE/CONT'D settings. Returns {} for scripts that did not
 * come from Final Draft, so the defaults apply.
 */
export function fdxPaginationOptions(script: Script): PaginationOptions {
  if (!script.fdx) return {};
  const options: PaginationOptions = {};
  const linesPerInch = PAGE.linesPerInch;
  const elements: Partial<Record<ElementType, Partial<ElementLayout>>> = {};
  const paginateAs: Partial<Record<ElementType, ElementType>> = {};
  for (const settings of fdxNodes(script, "ElementSettings")) {
    const type = FDX_ELEMENT_TYPES[attribute(settings, "Type") ?? ""];
    if (!type) continue;
    const paragraph = children(settings, "ParagraphSpec")[0];
    const font = children(settings, "FontSpec")[0];
    const behavior = children(settings, "Behavior")[0];
    const element: Partial<ElementLayout> = {};
    const left = number(paragraph, "LeftIndent"), right = number(paragraph, "RightIndent");
    if (left !== undefined) element.left = left;
    if (right !== undefined) element.right = right;
    const first = number(paragraph, "FirstIndent");
    if (first !== undefined) element.firstIndent = first;
    const before = number(paragraph, "SpaceBefore");
    if (before !== undefined) element.spaceBefore = before / (72 / linesPerInch);
    const spacing = number(paragraph, "Spacing");
    if (spacing !== undefined && spacing > 0) element.spacing = spacing;
    const align = attribute(paragraph, "Alignment")?.toLowerCase();
    if (align === "left" || align === "right" || align === "center") element.align = align;
    const style = attribute(font, "Style");
    if (style !== undefined) {
      const flags = new Set(style.split("+"));
      element.caps = flags.has("AllCaps");
      element.bold = flags.has("Bold");
      element.italic = flags.has("Italic");
      element.underline = flags.has("Underline");
    }
    elements[type] = element;
    const as = FDX_ELEMENT_TYPES[attribute(behavior, "PaginateAs") ?? ""];
    if (as) paginateAs[type] = as;
  }
  if (Object.keys(elements).length) options.elements = elements;
  if (Object.keys(paginateAs).length) options.paginateAs = paginateAs;

  const page = fdxNodes(script, "PageLayout")[0];
  if (page) {
    const margin = (name: string) => {
      const points = number(page, name);
      return points !== undefined ? points / 72 : undefined;
    };
    const top = margin("TopMargin"), bottom = margin("BottomMargin"), header = margin("HeaderMargin"), footer = margin("FooterMargin");
    options.page = {
      ...PAGE,
      ...(top !== undefined ? { top } : {}), ...(bottom !== undefined ? { bottom } : {}),
      ...(header !== undefined ? { header } : {}), ...(footer !== undefined ? { footer } : {}),
    };
    const sentences = yes(attribute(page, "BreakDialogueAndActionAtSentences"));
    if (sentences !== undefined) options.breakAtSentences = sentences;
  }

  const dialogue = fdxNodes(script, "DialogueBreaks")[0];
  if (dialogue) {
    const auto = yes(attribute(dialogue, "AutomaticCharacterContinueds"));
    if (auto !== undefined) options.autoContinueds = auto;
    const bottom = yes(attribute(dialogue, "BottomOfPage")), top = yes(attribute(dialogue, "TopOfNext"));
    if (bottom !== undefined || top !== undefined) options.dialogueBreaks = bottom !== false || top !== false;
    const more = attribute(dialogue, "DialogueBottom"), contd = attribute(dialogue, "DialogueTop");
    if (more) options.more = more;
    if (contd) options.contd = contd;
  }
  const scenes = fdxNodes(script, "SceneBreaks")[0];
  if (scenes) {
    const bottom = yes(attribute(scenes, "SceneBottomOfPage")), top = yes(attribute(scenes, "SceneTopOfNext"));
    if (bottom || top) options.sceneContinueds = true;
    const sceneBottom = attribute(scenes, "SceneBottom"), sceneTop = attribute(scenes, "SceneTop");
    if (sceneBottom) options.sceneBottom = sceneBottom;
    if (sceneTop) options.sceneTop = sceneTop;
  }
  return options;
}

/** Options for a script: its own FDX layout and template page rules, then the caller's settings on top. */
export function scriptPaginationOptions(script: Script, overrides: PaginationOptions = {}): PaginationOptions {
  const own = fdxPaginationOptions(script);
  const elements = { ...own.elements };
  for (const [type, value] of Object.entries(overrides.elements ?? {})) {
    elements[type as ElementType] = { ...elements[type as ElementType], ...value };
  }
  const breaks = templateBreakBefore(script.template);
  return {
    ...own, ...(breaks.length ? { breakBefore: breaks } : {}), ...overrides,
    ...(own.elements || overrides.elements ? { elements } : {}),
  };
}
