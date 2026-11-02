// Final Draft (.fdx) import and export. Everything the model has no field for is kept as raw XML,
// so a script read from FDX and written back loses nothing Final Draft wrote.
//
// A few things are mapped rather than kept raw, because the app edits them:
// - A scene heading's SceneProperties Summary (the index card text) becomes the synopsis paragraph after the
//   heading, and is written back from it.
// - LockedPage positions are Final Draft character counts; on import each is tied to the paragraph it falls in
//   (private x-paragraph and x-offset attributes), and export turns that back into a Position, so a lock follows
//   its text through edits.
// - Revision deletion marks sit inside their paragraph, so they follow its text: the app's own, and Final Draft's
//   DeletedText marks, which import moves there. Export counts them all back out into DeletedText.
// - An OmittedScene the app made keeps the omitted paragraphs whole; export writes them as Final Draft's.
import { isUsableId, newId } from "./ids.ts";
import { readInline } from "./inline.ts";
import {
  NON_PRINTING, type ElementType, type FdxParagraphExtras, type Paragraph, type Run, type Script, type TitleField,
  type XmlNode, normalizeRuns, plainText,
} from "./model.ts";
import { XmlError, attr, cloneNode, disallowedCharacters, parseXml, serializeXml, textOf } from "./xml.ts";
import { templatePageBreaks } from "./template-rules.ts";

const FDX_TYPES: Record<string, ElementType> = {
  "Scene Heading": "sceneHeading", "Action": "action", "Character": "character", "Parenthetical": "parenthetical",
  "Dialogue": "dialogue", "Transition": "transition", "Shot": "shot", "General": "general", "Lyrics": "lyrics",
  "Cast List": "castList", "New Act": "newAct", "End of Act": "endOfAct",
};
const TYPE_NAMES = Object.fromEntries(Object.entries(FDX_TYPES).map(([name, type]) => [type, name])) as Record<ElementType, string>;

const STYLE_FLAGS = { Bold: "bold", Italic: "italic", Underline: "underline", Strikeout: "strikeout", AllCaps: "allCaps" } as const;
const ID_ATTRS = ["id", "Id", "ID"];
// Attributes the model reads into fields; all others stay in fdx.attrs.
const MODELED_ATTRS = new Set(["Type", "Number", "Alignment", ...ID_ATTRS]);

/** Private attributes on a LockedPage that tie it to a paragraph; writeFdx turns them back into a Position. */
export const LOCK_PARAGRAPH_ATTR = "x-paragraph";
export const LOCK_OFFSET_ATTR = "x-offset";
/** A revision deletion mark kept inside its paragraph (Offset counts from the paragraph's start). */
export const DELETION_NODE = "DeletedTextLocation";
/**
 * Private attribute on an OmittedScene the app made: the omitted paragraphs as JSON, complete with what FDX cannot
 * hold (synopses, sections, notes). writeFdx turns them into Final Draft's OmittedScene paragraphs.
 */
export const OMITTED_NATIVE_ATTR = "x-paragraphs";

const elementsOf = (node: XmlNode, name?: string) =>
  node.children.filter((child): child is XmlNode => typeof child !== "string" && (!name || child.name === name));

class Reader {
  private readonly seen = new Set<string>();
  private readonly warnings: string[] | undefined;

  constructor(warnings?: string[]) {
    this.warnings = warnings;
  }

  claimId(candidate: string | undefined): string {
    if (isUsableId(candidate) && !this.seen.has(candidate)) {
      this.seen.add(candidate);
      return candidate;
    }
    let id = newId();
    while (this.seen.has(id)) id = newId();
    this.seen.add(id);
    return id;
  }

  paragraph(node: XmlNode): Paragraph {
    const rawType = attr(node, "Type");
    const type = rawType !== undefined ? FDX_TYPES[rawType] : undefined;
    const idAttr = ID_ATTRS.find((name) => attr(node, name) !== undefined);
    const id = this.claimId(idAttr ? attr(node, idAttr) : undefined);
    const fdx: FdxParagraphExtras = {};
    if (!type) fdx.type = rawType ?? null;
    if (idAttr && idAttr !== "id") fdx.idAttr = idAttr;

    const paragraph: Paragraph = { id, type: type ?? "general", runs: [] };
    const number = attr(node, "Number");
    if (number !== undefined) paragraph.sceneNumber = number;
    const alignment = attr(node, "Alignment");
    if (alignment !== undefined) paragraph.alignment = alignment;
    const extraAttrs = node.attrs.filter(([name, value]) => {
      if (name === "StartsNewPage" && value === "Yes") {
        paragraph.startsNewPage = true;
        return false;
      }
      return !MODELED_ATTRS.has(name);
    });
    if (extraAttrs.length) fdx.attrs = extraAttrs;

    const texts = node.children.filter((child): child is XmlNode => typeof child !== "string" && child.name === "Text");
    if (!texts.length && !node.children.some((child) => typeof child === "string" && /\S/.test(child))) fdx.textless = true;
    const runs: Run[] = [];
    let seenText = false;
    for (const child of node.children) {
      if (typeof child === "string") {
        // Not valid FDX, but some tools write it. Read it as plain text rather than refuse the file.
        if (/\S/.test(child)) {
          this.warnings?.push(`Paragraph ${id}: text outside a Text element was read as plain text.`);
          seenText = true;
          runs.push({ text: child.trim() });
        }
      } else if (child.name === "Text") {
        seenText = true;
        runs.push(this.run(child));
      } else {
        (seenText ? (fdx.after ??= []) : (fdx.before ??= [])).push(child);
      }
    }
    paragraph.runs = normalizeRuns(runs);
    if (texts.length && !paragraph.runs.length && texts[0]!.attrs.length) fdx.emptyText = texts[0]!.attrs;
    if (paragraph.type === "sceneHeading") paragraph.sceneId = id;
    if (Object.keys(fdx).length) paragraph.fdx = fdx;
    return paragraph;
  }

  run(node: XmlNode): Run {
    const run: Run = { text: textOf(node) };
    const fdx: Record<string, string> = {};
    for (const [name, value] of node.attrs) {
      if (name !== "Style" || value === "") {
        // An explicit empty Style is kept as written.
        fdx[name] = value;
        continue;
      }
      const flags = value.split("+").filter(Boolean);
      if (!flags.length) {
        fdx[name] = value;
        continue;
      }
      const extra: string[] = [];
      for (const flag of flags) {
        const mark = STYLE_FLAGS[flag as keyof typeof STYLE_FLAGS];
        if (mark) run[mark] = true;
        else extra.push(flag);
      }
      if (extra.length) run.styleExtra = extra.join("+");
    }
    if (Object.keys(fdx).length) run.fdx = fdx;
    return run;
  }

  dualBlock(wrapper: XmlNode, dual: XmlNode): Paragraph[] {
    const inner = dual.children.filter((child): child is XmlNode => typeof child !== "string" && child.name === "Paragraph");
    if (!inner.length) return [this.paragraph(wrapper)];
    const block = this.claimId(ID_ATTRS.map((name) => attr(wrapper, name)).find(Boolean));
    const shell = cloneNode(wrapper);
    const shellDual = shell.children.find((child): child is XmlNode => typeof child !== "string" && child.name === "DualDialogue")!;
    shellDual.children = shellDual.children.filter((child) => typeof child === "string" || child.name !== "Paragraph");
    let side: 1 | 2 = 1;
    let characters = 0;
    const paragraphs = inner.map((node) => {
      const paragraph = this.paragraph(node);
      if (paragraph.type === "character" && ++characters === 2) side = 2;
      paragraph.dual = { block, side };
      return paragraph;
    });
    if (paragraphs[0]) (paragraphs[0].fdx ??= {}).dualWrapper = shell;
    return paragraphs;
  }
}

// ----- Positions -------------------------------------------------------------------------------------------

function fdxLength(paragraph: Paragraph): number {
  let length = 0;
  for (const run of paragraph.runs) if (!run.note) length += run.text.length;
  return length;
}

/**
 * An offset into a paragraph's text, where inline notes count, as Final Draft counts it: notes are not written
 * to FDX, so they do not. An offset inside a note goes to the note's start.
 */
export function fdxOffset(paragraph: Paragraph, offset: number): number {
  let model = 0, fdx = 0;
  for (const run of paragraph.runs) {
    if (offset <= model) break;
    if (!run.note) fdx += Math.min(run.text.length, offset - model);
    model += run.text.length;
  }
  return fdx;
}

/** A Final Draft offset into a paragraph as an offset into its text, past the inline notes before it. */
export function modelOffset(paragraph: Paragraph, offset: number): number {
  let model = 0, fdx = 0;
  for (const run of paragraph.runs) {
    if (!run.note) {
      if (offset <= fdx + run.text.length) return model + Math.max(0, offset - fdx);
      fdx += run.text.length;
    }
    model += run.text.length;
  }
  return model;
}

/**
 * Where each paragraph starts in Final Draft's character count, which LockedPage Position and DeletedTextLocation
 * Offset use: the text of every paragraph in the file, each followed by one paragraph break. (Measured on locked
 * scripts: every locked position lands exactly on a paragraph start when counted this way.) Non-printing
 * paragraphs and inline notes are not written to FDX, so they do not count.
 */
export function fdxPositions(paragraphs: readonly Paragraph[]): Map<string, number> {
  const positions = new Map<string, number>();
  let at = 0;
  for (const paragraph of paragraphs) {
    if (NON_PRINTING.has(paragraph.type)) continue;
    if (!positions.has(paragraph.id)) positions.set(paragraph.id, at);
    at += fdxLength(paragraph) + 1;
  }
  return positions;
}

/** The paragraph and offset (into its text, notes included) at a Final Draft character position, or undefined past the end of the script. */
export function fdxPositionAt(paragraphs: readonly Paragraph[], position: number): { paragraphId: string; offset: number } | undefined {
  let at = 0;
  for (const paragraph of paragraphs) {
    if (NON_PRINTING.has(paragraph.type)) continue;
    const length = fdxLength(paragraph);
    if (position <= at + length) return { paragraphId: paragraph.id, offset: modelOffset(paragraph, Math.max(0, position - at)) };
    at += length + 1;
  }
  return undefined;
}

/**
 * Move Final Draft's deletion marks (DeletedTextLocation, a global Offset) into the paragraphs they fall in, with
 * an offset from the paragraph's start, where the app keeps its own marks: they follow their paragraph's text
 * through edits, and writeFdx counts them back out. A DeletedText element this cannot represent exactly (marks out
 * of order, past the end of the script, or with other attributes) is left as it is.
 */
function anchorDeletions(script: Script): void {
  const placed = (node: XmlNode) => {
    const marks: { at: { paragraphId: string; offset: number }; revision: string }[] = [];
    let previous = -1;
    for (const child of node.children) {
      if (typeof child === "string") continue;
      const offset = Number(attr(child, "Offset"));
      const revision = attr(child, "RevisionID");
      const plain = child.name === DELETION_NODE && !child.children.length && child.attrs.length === 2 && revision !== undefined;
      const at = plain && Number.isInteger(offset) && offset >= previous ? fdxPositionAt(script.paragraphs, offset) : undefined;
      if (!at) return null;
      previous = offset;
      marks.push({ at, revision: revision! });
    }
    return marks;
  };
  for (const node of [...script.fdx!.before, ...script.fdx!.after].filter((n) => n.name === "DeletedText")) {
    const marks = placed(node);
    if (!marks) continue;
    const byId = new Map(script.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
    for (const { at, revision } of marks) {
      const paragraph = byId.get(at.paragraphId)!;
      const fdx = (paragraph.fdx ??= {});
      (fdx.after ??= []).push({ name: DELETION_NODE, attrs: [["Offset", String(at.offset)], ["RevisionID", revision]], children: [] });
    }
    node.children = node.children.filter((child) => typeof child === "string");
  }
}

/** Tie each LockedPage to the paragraph its Position falls in, so the lock follows the text through edits. */
function annotateLocks(script: Script): void {
  for (const locked of [...script.fdx!.before, ...script.fdx!.after].filter((node) => node.name === "LockedPages")) {
    for (const page of elementsOf(locked, "LockedPage")) {
      const position = Number.parseInt(attr(page, "Position") ?? "", 10);
      const at = Number.isFinite(position) ? fdxPositionAt(script.paragraphs, position) : undefined;
      if (!at) continue;
      page.attrs = [...page.attrs, [LOCK_PARAGRAPH_ATTR, at.paragraphId], [LOCK_OFFSET_ATTR, String(at.offset)]];
    }
  }
}

// ----- Scene summaries -------------------------------------------------------------------------------------

function sceneProperties(paragraph: Paragraph): XmlNode | undefined {
  return paragraph.fdx?.before?.find((node) => node.name === "SceneProperties");
}

function summaryOf(paragraph: Paragraph): XmlNode | undefined {
  const properties = sceneProperties(paragraph);
  return properties ? elementsOf(properties, "Summary")[0] : undefined;
}

function summaryText(summary: XmlNode): string {
  return elementsOf(summary, "Paragraph").map((paragraph) => elementsOf(paragraph, "Text").map(textOf).join("")).join("\n");
}

/**
 * Final Draft keeps an index card's summary in the scene heading's SceneProperties as Summary paragraphs. It
 * becomes the synopsis paragraph right after the heading, where the app reads a scene's synopsis. The Summary XML
 * stays on the heading too, so an unchanged summary is written back exactly as it was.
 */
function summariesToSynopses(paragraphs: Paragraph[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (const paragraph of paragraphs) {
    out.push(paragraph);
    if (paragraph.type !== "sceneHeading") continue;
    const summary = summaryOf(paragraph);
    const text = summary ? summaryText(summary) : "";
    if (text.trim()) out.push({ id: newId(), type: "synopsis", runs: [{ text }] });
  }
  return out;
}

function summaryNode(text: string, template?: XmlNode): XmlNode {
  const first = template ? elementsOf(template, "Paragraph")[0] : undefined;
  const firstText = first ? elementsOf(first, "Text")[0] : undefined;
  const paragraphAttrs: [string, string][] = first?.attrs ?? [["Alignment", "Left"], ["FirstIndent", "0.00"], ["Leading", "Regular"],
    ["LeftIndent", "0.00"], ["RightIndent", "1.39"], ["SpaceBefore", "0"], ["Spacing", "1"], ["StartsNewPage", "No"]];
  const textAttrs: [string, string][] = firstText?.attrs ?? [["Font", "Courier Final Draft"], ["RevisionID", "0"], ["Size", "12"], ["Style", ""]];
  return {
    name: "Summary", attrs: template?.attrs ?? [],
    children: text.split("\n").map((line) => ({
      name: "Paragraph", attrs: [...paragraphAttrs], children: [{ name: "Text", attrs: [...textAttrs], children: line ? [line] : [] }],
    })),
  };
}

/** A heading whose SceneProperties Summary holds a synopsis, or has none when the synopsis is undefined. */
function withSummary(heading: Paragraph, synopsis: string | undefined): Paragraph {
  const existing = summaryOf(heading);
  if ((existing ? summaryText(existing) : undefined) === synopsis) return heading;
  const fdx = structuredClone(heading.fdx ?? {});
  const before = (fdx.before ??= []);
  let node = before.find((n) => n.name === "SceneProperties");
  if (!node) before.unshift((node = { name: "SceneProperties", attrs: [["Title", ""]], children: [] }));
  const kept = node.children.filter((child) => typeof child === "string" || child.name !== "Summary");
  node.children = synopsis !== undefined ? [summaryNode(synopsis, existing), ...kept] : kept;
  return { ...heading, fdx };
}

export interface FdxReadOptions {
  /** Receives one message per repair made to an invalid file. */
  warnings?: string[];
}

export function parseFdx(source: string, options: FdxReadOptions = {}): Script {
  const root = parseXml(source, options);
  if (root.name !== "FinalDraft") throw new XmlError("Not a Final Draft document: the root element is not FinalDraft.");
  const index = root.children.findIndex((child) => typeof child !== "string" && child.name === "Content");
  if (index < 0) throw new XmlError("The document has no Content element.");
  const content = root.children[index] as XmlNode;
  const elements = (list: (XmlNode | string)[]) => list.filter((child): child is XmlNode => typeof child !== "string");

  const reader = new Reader(options.warnings);
  const paragraphs: Paragraph[] = [];
  const queue = elements(content.children);
  for (let node = queue.shift(); node; node = queue.shift()) {
    if (node.name !== "Paragraph") {
      // A wrapper some tools put around the paragraphs: read what is inside it.
      if (node.name === "Paragraphs") queue.unshift(...elements(node.children));
      options.warnings?.push(node.name === "Paragraphs" ? "Read paragraphs from inside a <Paragraphs> wrapper." : `Skipped <${node.name}> inside Content.`);
      continue;
    }
    const dual = elements(node.children).find((child) => child.name === "DualDialogue");
    if (dual) paragraphs.push(...reader.dualBlock(node, dual));
    else paragraphs.push(reader.paragraph(node));
  }
  const script: Script = {
    titlePage: [],
    paragraphs: summariesToSynopses(paragraphs),
    fdx: {
      rootAttrs: root.attrs,
      contentAttrs: content.attrs,
      before: elements(root.children.slice(0, index)),
      after: elements(root.children.slice(index + 1)),
    },
  };
  annotateLocks(script);
  anchorDeletions(script);
  return script;
}

function styleValue(run: Run): string {
  const flags = (Object.entries(STYLE_FLAGS) as [string, keyof Run][]).filter(([, mark]) => run[mark]).map(([flag]) => flag);
  if (run.styleExtra) flags.push(run.styleExtra);
  return flags.join("+");
}

function textNode(run: Run, caps = false): XmlNode {
  // Final Draft drops an element's AllCaps for any run that names its own Style, so styled runs repeat it.
  let style = styleValue(run);
  if (caps && style && !style.split("+").includes("AllCaps")) style = `${style}+AllCaps`;
  const attrs: [string, string][] = Object.entries(run.fdx ?? {})
    .filter(([name]) => name !== "InklotTagId" && !(style && name === "Style"));
  if (style) attrs.push(["Style", style]);
  attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { name: "Text", attrs, children: run.text ? [run.text] : [] };
}

interface WriteContext {
  options: FdxWriteOptions;
  positions: Map<string, number>;
  /** Deletion marks found inside paragraphs, with Final Draft offsets. */
  deletions: { offset: number; revision: string }[];
  /** Paragraphs the document template starts on a new page, written as Final Draft's StartsNewPage. */
  breaks: ReadonlySet<string>;
  /** Final Draft element names whose ElementSettings set AllCaps. */
  caps?: ReadonlySet<string>;
}

/** Element types that the document's ElementSettings print in capitals. */
function capsElements(nodes: readonly XmlNode[]): Set<string> {
  const out = new Set<string>();
  for (const node of nodes) {
    if (node.name !== "ElementSettings") continue;
    const font = node.children.find((child): child is XmlNode => typeof child !== "string" && child.name === "FontSpec");
    const type = attr(node, "Type"), style = font ? attr(font, "Style") : undefined;
    if (type && style?.split("+").includes("AllCaps")) out.add(type);
  }
  return out;
}

function paragraphNode(paragraph: Paragraph, context: WriteContext): XmlNode {
  const fdx = paragraph.fdx ?? {};
  const attrs: [string, string][] = [];
  if (paragraph.type === "general" && fdx.type !== undefined) {
    if (fdx.type !== null) attrs.push(["Type", fdx.type]);
  } else {
    attrs.push(["Type", TYPE_NAMES[paragraph.type] ?? "General"]);
  }
  if (paragraph.sceneNumber !== undefined) attrs.push(["Number", paragraph.sceneNumber]);
  if (paragraph.alignment !== undefined) attrs.push(["Alignment", paragraph.alignment]);
  const startsPage = paragraph.startsNewPage || context.breaks.has(paragraph.id);
  const extra = (fdx.attrs ?? []).filter(([name]) => !(startsPage && name === "StartsNewPage"));
  attrs.push(...extra);
  if (startsPage) attrs.push(["StartsNewPage", "Yes"]);
  attrs.push([fdx.idAttr ?? "id", paragraph.id]);

  const children: XmlNode[] = [...(fdx.before ?? []).map(cloneNode)];
  const notes = paragraph.runs.filter((run) => run.note);
  for (const note of notes) context.options.warnings?.push(`Skipped inline note "${note.text.slice(0, 60)}": FDX has no equivalent.`);
  const runs = normalizeRuns(paragraph.runs.filter((run) => !run.note));
  const caps = context.caps?.has(attrs.find(([name]) => name === "Type")?.[1] ?? "") ?? false;
  if (runs.length) children.push(...runs.map((run) => textNode(run, caps)));
  else if (!fdx.textless) children.push({ name: "Text", attrs: fdx.emptyText ?? [], children: [] });
  const start = context.positions.get(paragraph.id) ?? 0;
  const length = fdxLength(paragraph);
  for (const node of fdx.after ?? []) {
    if (node.name === "OmittedScene" && attr(node, OMITTED_NATIVE_ATTR) !== undefined) {
      children.push(omittedSceneNode(node, context));
      continue;
    }
    if (node.name !== DELETION_NODE) {
      children.push(cloneNode(node));
      continue;
    }
    // The mark's offset counts inline notes; Final Draft's does not.
    const offset = Math.min(length, fdxOffset(paragraph, Math.max(0, Number.parseInt(attr(node, "Offset") ?? "0", 10) || 0)));
    context.deletions.push({ offset: start + offset, revision: attr(node, "RevisionID") ?? "0" });
  }
  return { name: "Paragraph", attrs, children };
}

function defaultDualWrapper(block: string): XmlNode {
  return { name: "Paragraph", attrs: [["Type", "General"], ["id", block]], children: [{ name: "DualDialogue", attrs: [], children: [] }] };
}

// ----- Title page ------------------------------------------------------------------------------------------

// Other spellings of the title page keys, from Fountain files and older drafts.
const TITLE_ALIASES: Record<string, string> = { authors: "author", notes: "copyright", draft: "draft date", date: "draft date" };
const titleKey = (key: string) => TITLE_ALIASES[key.trim().toLowerCase()] ?? key.trim().toLowerCase();

/** A title page line. Field values come from Fountain title pages, so **bold**, *italic* and _underline_ become styles. */
function titleLine(text: string, alignment: "Left" | "Center" | "Right"): XmlNode {
  const runs = normalizeRuns(readInline(text).filter((run) => !run.note));
  const textNodes = (runs.length ? runs : [{ text: "" }]).map((run): XmlNode => ({
    name: "Text",
    attrs: [["Font", "Courier Final Draft"], ["RevisionID", "0"], ["Size", "12"], ["Style", styleValue(run)]],
    children: run.text ? [run.text] : [],
  }));
  return {
    name: "Paragraph",
    attrs: [["Alignment", alignment], ["FirstIndent", "0.00"], ["Leading", "Regular"], ["LeftIndent", "1.00"],
      ["RightIndent", "7.50"], ["SpaceBefore", "0"], ["Spacing", "1"], ["StartsNewPage", "No"]],
    children: textNodes,
  };
}

/** Rows above the title on a generated title page: a third of the way down. */
const TITLE_ROW = 17;

/**
 * Final Draft TitlePage XML for title page fields, in the standard layout: the title centered a third of the way
 * down with the credit, authors and source under it; copyright and notes, then the contact block, at the foot on
 * the left; the draft date at the foot on the right. Every printed line is a paragraph with Final Draft's own
 * indents and spacing, and blank paragraphs place the lines. `rows` is the number of lines between the margins.
 * Undefined when no field has text.
 */
export function fdxTitlePageNode(fields: readonly TitleField[], rows = 54): XmlNode | undefined {
  const lines = (key: string) => fields.filter((field) => titleKey(field.key) === key).flatMap((field) => field.values);
  const title = lines("title"), credit = lines("credit"), author = lines("author"), source = lines("source");
  const top: string[] = title.map((text) => text.toUpperCase());
  if (credit.length || author.length) top.push("");
  // Without a credit line, a second blank keeps the authors apart from the title when the page is read back.
  if (!credit.length && author.length && title.length) top.push("");
  top.push(...credit);
  if (credit.length && author.length) top.push("");
  top.push(...author);
  if (source.length) top.push("", "");
  top.push(...source);

  const notes = lines("copyright"), contact = lines("contact"), date = lines("draft date");
  const bottom: [string, "Left" | "Right"][] = notes.map((text): [string, "Left"] => [text, "Left"]);
  if (notes.length && contact.length) bottom.push(["", "Left"]);
  bottom.push(...contact.map((text): [string, "Left"] => [text, "Left"]), ...date.map((text): [string, "Right"] => [text, "Right"]));
  if (!top.some((text) => text.trim()) && !bottom.some(([text]) => text.trim())) return undefined;

  const paragraphs: XmlNode[] = [];
  const startTop = top.length ? Math.max(0, Math.min(TITLE_ROW, rows - bottom.length - top.length - 1)) : 0;
  for (let i = 0; i < startTop; i++) paragraphs.push(titleLine("", "Left"));
  for (const text of top) paragraphs.push(titleLine(text, "Center"));
  const startBottom = Math.max(paragraphs.length + (top.length ? 1 : 0), rows - bottom.length);
  while (paragraphs.length < startBottom && bottom.length) paragraphs.push(titleLine("", "Left"));
  for (const [text, align] of bottom) paragraphs.push(titleLine(text, align));
  return { name: "TitlePage", attrs: [], children: [{ name: "Content", attrs: [], children: paragraphs }] };
}

export interface FdxWriteOptions {
  /** Explicit deliveries may require every ScriptNote to have its source resolved. */
  strictOrphanNotes?: boolean;
  /** Receives one message per paragraph that FDX cannot hold (Fountain sections, notes, and synopses not under a heading). */
  warnings?: string[];
}

function skipped(paragraph: Paragraph, options: FdxWriteOptions): void {
  options.warnings?.push(`Skipped ${paragraph.type} "${plainText(paragraph.runs).slice(0, 60)}": FDX has no equivalent.`);
}

/** The paragraphs as written: a synopsis right after a scene heading moves into the heading's Summary. */
function withSummaries(paragraphs: readonly Paragraph[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]!;
    if (paragraph.type !== "sceneHeading") {
      out.push(paragraph);
      continue;
    }
    const next = paragraphs[i + 1];
    const synopsis = next?.type === "synopsis" ? plainText(next.runs) : undefined;
    out.push(withSummary(paragraph, synopsis?.trim() ? synopsis : undefined));
    if (next?.type === "synopsis") i++;
  }
  return out;
}

type LockStarts = Map<string, { at: number; printed?: Paragraph }>;

/**
 * Where each paragraph starts in Final Draft's character count, for locked pages. A paragraph FDX does not hold
 * (a section, synopsis or note) starts where the next printed paragraph does, which is where its page starts.
 */
function lockStarts(paragraphs: readonly Paragraph[]): LockStarts {
  const starts: LockStarts = new Map();
  let at = 0;
  for (const paragraph of paragraphs) {
    const printed = !NON_PRINTING.has(paragraph.type);
    if (!starts.has(paragraph.id)) starts.set(paragraph.id, printed ? { at, printed: paragraph } : { at });
    if (printed) at += fdxLength(paragraph) + 1;
  }
  return starts;
}

/** Document-level elements with locked page positions recomputed and the app's deletion marks added. */
function finishExtras(nodes: readonly XmlNode[], context: WriteContext, starts: LockStarts): XmlNode[] {
  return nodes.map((node) => {
    if (node.name !== "LockedPages") return node;
    const copy = cloneNode(node);
    copy.children = copy.children.filter((page) => {
      if (typeof page === "string" || page.name !== "LockedPage") return true;
      const paragraph = attr(page, LOCK_PARAGRAPH_ATTR), offset = Number.parseInt(attr(page, LOCK_OFFSET_ATTR) ?? "0", 10) || 0;
      page.attrs = page.attrs.filter(([name]) => name !== LOCK_PARAGRAPH_ATTR && name !== LOCK_OFFSET_ATTR);
      // Never tied to a paragraph (its Position was past the end of the script): kept as Final Draft wrote it.
      if (paragraph === undefined) return true;
      const start = starts.get(paragraph);
      if (!start) {
        // The text it started with is gone and nothing marks where it was: any Position would be a wrong one.
        context.options.warnings?.push(`Left out locked page ${attr(page, "PageNumber") ?? ""}: the text it started with is gone.`);
        return false;
      }
      // The offset counts inline notes; Final Draft's position does not.
      const within = start.printed ? Math.min(fdxOffset(start.printed, offset), fdxLength(start.printed)) : 0;
      const position = String(start.at + within);
      page.attrs = page.attrs.map(([name, value]): [string, string] => [name, name === "Position" ? position : value]);
      if (!page.attrs.some(([name]) => name === "Position")) page.attrs.push(["Position", position]);
      return true;
    });
    return copy;
  });
}

function addDeletions(before: XmlNode[], after: XmlNode[], deletions: WriteContext["deletions"]): void {
  if (!deletions.length) return;
  const locations: XmlNode[] = deletions.sort((a, b) => a.offset - b.offset)
    .map(({ offset, revision }) => ({ name: "DeletedTextLocation", attrs: [["Offset", String(offset)], ["RevisionID", revision]], children: [] }));
  for (const list of [before, after]) {
    const index = list.findIndex((node) => node.name === "DeletedText");
    if (index < 0) continue;
    list[index] = { ...list[index]!, children: [...list[index]!.children, ...locations] };
    return;
  }
  // Final Draft writes DeletedText right after Revisions.
  const node: XmlNode = { name: "DeletedText", attrs: [], children: locations };
  for (const list of [before, after]) {
    const index = list.findIndex((n) => n.name === "Revisions");
    if (index >= 0) {
      list.splice(index + 1, 0, node);
      return;
    }
  }
  after.push(node);
}

/** Paragraphs (synopses already moved into Summary) as Content's children: dual dialogue blocks wrapped. */
function contentNodes(paragraphs: readonly Paragraph[], context: WriteContext): XmlNode[] {
  const { options } = context;
  const content: XmlNode[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]!;
    if (NON_PRINTING.has(paragraph.type)) {
      skipped(paragraph, options);
      continue;
    }
    if (!paragraph.dual) {
      content.push(paragraphNode(paragraph, context));
      continue;
    }
    const block = paragraph.dual.block;
    const wrapper = cloneNode(paragraph.fdx?.dualWrapper ?? defaultDualWrapper(block));
    let target = wrapper.children.find((child): child is XmlNode => typeof child !== "string" && child.name === "DualDialogue");
    if (!target) wrapper.children.unshift(target = { name: "DualDialogue", attrs: [], children: [] });
    for (; i < paragraphs.length && paragraphs[i]!.dual?.block === block; i++) {
      const inner = paragraphs[i]!;
      if (NON_PRINTING.has(inner.type)) skipped(inner, options);
      else target.children.push(paragraphNode(inner, context));
    }
    i--;
    content.push(wrapper);
  }
  return content;
}

export function writeFdx(script: Script, options: FdxWriteOptions = {}): string {
  // Work on a copy: saving must never attach an orphan to its former absolute offset.
  script = structuredClone(script);
  const finishNotes = (nodes: readonly XmlNode[]): void => {
    for (const node of nodes) {
      if (node.name === "ScriptNote" && attr(node, "InklotUnresolvedNote") === "Yes") {
        if (options.strictOrphanNotes) {
          throw new Error("A ScriptNote lost its source. Reattach or remove it before FDX export.");
        }
        node.attrs = node.attrs.filter(([name]) => !["Range", "InklotUnresolvedNote", "InklotDetachedKey"].includes(name));
        options.warnings?.push("Saved a ScriptNote as an unanchored note because its source text is gone.");
      }
      finishNotes(node.children.filter((n): n is XmlNode => typeof n !== "string"));
    }
  };
  finishNotes([
    ...(script.fdx?.before ?? []), ...(script.fdx?.after ?? []),
    ...script.paragraphs.flatMap((p) => [...(p.fdx?.before ?? []), ...(p.fdx?.after ?? [])]),
  ]);
  const paragraphs = withSummaries(script.paragraphs);
  const context: WriteContext = {
    options, positions: fdxPositions(paragraphs), deletions: [],
    breaks: templatePageBreaks(paragraphs, script.template),
    caps: capsElements([...(script.fdx?.before ?? []), ...(script.fdx?.after ?? [])]),
  };
  const content = contentNodes(paragraphs, context);

  const extras = script.fdx;
  const starts = lockStarts(script.paragraphs);
  const before = finishExtras(extras?.before ?? [], context, starts);
  const after = finishExtras(extras?.after ?? [], context, starts);
  addDeletions(before, after, context.deletions);
  const rootAttrs = extras?.rootAttrs ?? [["DocumentType", "Script"], ["Template", "No"], ["Version", "5"]];
  // Final Draft's own title page wins; otherwise the fields are laid out the standard way.
  const hasTitlePage = [...before, ...after].some((node) => node.name === "TitlePage");
  const titlePage = hasTitlePage ? undefined : fdxTitlePageNode(script.titlePage);
  const root: XmlNode = {
    name: "FinalDraft",
    attrs: rootAttrs,
    children: [
      ...before,
      { name: "Content", attrs: extras?.contentAttrs ?? [], children: content },
      ...(titlePage ? [titlePage] : []),
      ...after,
    ],
  };
  // Text pasted from other programs can hold control characters XML cannot; serializeXml never writes them.
  const disallowed = disallowedCharacters(root);
  if (disallowed.length) {
    const kinds = [...new Set(disallowed)];
    const count = disallowed.length === 1 ? "a control character" : `${disallowed.length} control characters`;
    options.warnings?.push(`Left out ${count} that FDX cannot hold (${kinds.slice(0, 3).join(", ")}${kinds.length > 3 ? ", ..." : ""}); vertical tabs and form feeds became spaces.`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n${serializeXml(root)}\n`;
}

/**
 * Paragraphs as Final Draft writes them in Content, for XML that holds script text (an OmittedScene): a synopsis
 * after a heading in its Summary, dual dialogue in its block.
 */
export function fdxParagraphNodes(paragraphs: readonly Paragraph[], options: FdxWriteOptions = {}): XmlNode[] {
  return contentNodes(withSummaries(paragraphs), { options, positions: new Map(), deletions: [], breaks: new Set() });
}

/** An OmittedScene the app made, as Final Draft writes it: its paragraphs as Paragraph elements. */
function omittedSceneNode(node: XmlNode, context: WriteContext): XmlNode {
  let paragraphs: Paragraph[] = [];
  try {
    const parsed = JSON.parse(attr(node, OMITTED_NATIVE_ATTR)!) as unknown;
    if (Array.isArray(parsed)) paragraphs = parsed as Paragraph[];
  } catch {
    context.options.warnings?.push("An omitted scene's text could not be read; it was written without it.");
  }
  return {
    name: "OmittedScene", attrs: node.attrs.filter(([name]) => name !== OMITTED_NATIVE_ATTR),
    children: fdxParagraphNodes(paragraphs, context.options),
  };
}

/** Paragraphs read from Final Draft Paragraph elements (an OmittedScene's), as parseFdx reads them. */
export function paragraphsFromFdxNodes(nodes: readonly XmlNode[]): Paragraph[] {
  const reader = new Reader();
  const out: Paragraph[] = [];
  for (const node of nodes) {
    const dual = elementsOf(node, "DualDialogue")[0];
    if (dual) out.push(...reader.dualBlock(node, dual));
    else out.push(reader.paragraph(node));
  }
  return summariesToSynopses(out);
}
