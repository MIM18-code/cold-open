// The title page: its fields, Final Draft's TitlePage XML, and the printed layout.
//
// Fields live in the document meta as TitleField[] with Fountain's keys (Title, Credit, Author, Source,
// Draft date, Contact, Copyright), so Fountain export writes them as they are. A script opened from FDX keeps
// Final Draft's own TitlePage XML in the FDX extras, and writeFdx writes those extras back instead of the
// fields. Saving the title page therefore also rebuilds that XML, so edits survive FDX export too. Printing
// lays out the TitlePage XML line by line, which reproduces a Final Draft title page exactly and gives the
// generated one the industry-standard layout.
import { PAGE, fdxTitlePageNode, wrap, type FdxDocumentExtras, type PageLayout, type Run, type Script, type TitleField, type XmlNode } from "@screenplay/engine";

export interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
}

export const FIELDS: readonly FieldDef[] = [
  { key: "Title", label: "Title" },
  { key: "Credit", label: "Credit", placeholder: "Written by" },
  { key: "Author", label: "Author(s)", multiline: true },
  { key: "Source", label: "Source", placeholder: "Based on the novel by", multiline: true },
  { key: "Draft date", label: "Draft date" },
  { key: "Contact", label: "Contact", multiline: true },
  { key: "Copyright", label: "Copyright and notes", multiline: true },
];

// Other spellings that mean the same field, from Fountain files and older drafts.
const ALIASES: Record<string, string> = { authors: "author", notes: "copyright", "draft": "draft date", date: "draft date" };
const canonicalKey = (key: string) => ALIASES[key.trim().toLowerCase()] ?? key.trim().toLowerCase();

export type TitleValues = Record<string, string>;

/** Field values keyed by FIELDS[].key, multi-line values joined with newlines. */
export function valuesOf(fields: readonly TitleField[]): TitleValues {
  const values: TitleValues = {};
  for (const def of FIELDS) {
    const lines = fields.filter((field) => canonicalKey(field.key) === def.key.toLowerCase()).flatMap((field) => field.values);
    values[def.key] = lines.join("\n");
  }
  return values;
}

/** TitleField[] from edited values. Empty fields are left out. */
export function fieldsOf(values: TitleValues): TitleField[] {
  return FIELDS.flatMap((def) => {
    const lines = (values[def.key] ?? "").split("\n").map((line) => line.trimEnd());
    while (lines.length && !lines.at(-1)) lines.pop();
    while (lines.length && !lines[0]) lines.shift();
    return lines.length ? [{ key: def.key, values: lines }] : [];
  });
}

/**
 * The stored fields after an edit. Fields the dialog does not show (a Fountain "Revision:" or "Format:") are
 * kept where they were, and an edited field keeps the key it was stored under ("Authors", "Notes").
 */
export function mergeFields(original: readonly TitleField[], values: TitleValues): TitleField[] {
  const edited = new Map(fieldsOf(values).map((field) => [field.key.toLowerCase(), field.values]));
  const placed = new Set<string>();
  const out: TitleField[] = [];
  for (const field of original) {
    const def = FIELDS.find((candidate) => candidate.key.toLowerCase() === canonicalKey(field.key));
    if (!def) {
      out.push(field);
      continue;
    }
    const key = def.key.toLowerCase();
    if (placed.has(key)) continue;
    placed.add(key);
    const lines = edited.get(key);
    if (lines) out.push({ key: field.key, values: lines });
  }
  for (const field of fieldsOf(values)) if (!placed.has(field.key.toLowerCase())) out.push(field);
  return out;
}

// ----- Final Draft TitlePage XML ---------------------------------------------------------------------------

function children(node: XmlNode, name?: string): XmlNode[] {
  return node.children.filter((child): child is XmlNode => typeof child !== "string" && (!name || child.name === name));
}
function attr(node: XmlNode, name: string): string | undefined {
  return node.attrs.find(([key]) => key === name)?.[1];
}
function textOf(node: XmlNode): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}

/** The TitlePage element Final Draft wrote, if the script came from an FDX file. */
export function fdxTitlePage(script: Pick<Script, "fdx">): XmlNode | undefined {
  return [...(script.fdx?.before ?? []), ...(script.fdx?.after ?? [])].find((node) => node.name === "TitlePage");
}

export interface TitleParagraph {
  runs: Run[];
  align: "left" | "center" | "right";
  left: number;
  right: number;
  /** Blank lines above. */
  spaceBefore: number;
}

/** The paragraphs of a TitlePage element, one per printed line before wrapping. */
export function titleParagraphs(node: XmlNode): TitleParagraph[] {
  const content = children(node, "Content")[0];
  if (!content) return [];
  return children(content, "Paragraph").map((paragraph) => {
    const align = (attr(paragraph, "Alignment") ?? "Left").toLowerCase();
    const number = (name: string, fallback: number) => {
      const value = Number.parseFloat(attr(paragraph, name) ?? "");
      return Number.isFinite(value) ? value : fallback;
    };
    const runs = children(paragraph, "Text").map((text): Run => {
      const style = new Set((attr(text, "Style") ?? "").split("+"));
      const value = textOf(text);
      return {
        text: style.has("AllCaps") ? value.toUpperCase() : value,
        ...(style.has("Bold") ? { bold: true as const } : {}),
        ...(style.has("Italic") ? { italic: true as const } : {}),
        ...(style.has("Underline") ? { underline: true as const } : {}),
      };
    });
    return {
      runs, align: align === "center" || align === "right" ? align : "left",
      left: number("LeftIndent", 1), right: number("RightIndent", 7.5), spaceBefore: number("SpaceBefore", 0) / 12,
    };
  });
}

const plain = (paragraph: TitleParagraph) => paragraph.runs.map((run) => run.text).join("");

/**
 * Guess the fields of a Final Draft title page, which stores only positioned lines. Centered lines near the top
 * are the title, credit, authors and source; a line with a year or "draft" is the draft date; the rest of the
 * lines at the foot are the contact block. Used to fill the Title Page dialog; printing uses the lines as they are.
 */
export function fieldsFromTitlePage(node: XmlNode): TitleField[] {
  let row = 0;
  const lines = titleParagraphs(node).map((paragraph) => {
    row += paragraph.spaceBefore;
    const line = { text: plain(paragraph).replace(/\t+/g, "   ").trim(), align: paragraph.align, row };
    row += 1;
    return line;
  }).filter((line) => line.text);
  const values: TitleValues = {};
  const add = (key: string, text: string) => (values[key] = values[key] ? `${values[key]}\n${text}` : text);
  const credit = /^(written|screenplay|teleplay|story|by\b|a screenplay)/i;
  const source = /^(based on|from the|adapted from|inspired by)/i;
  const date = /\b(19|20)\d\d\b|\bdraft\b|\brevis/i;
  const copyright = /©|\(c\)|copyright|\bwga\b|registered/i;
  let stage: "title" | "credit" | "author" | "source" = "title";
  let lastRow = -10;
  for (const line of lines) {
    if (copyright.test(line.text)) add("Copyright", line.text);
    else if (line.align === "center" && stage !== "source" && source.test(line.text)) {
      stage = "source";
      add("Source", line.text);
    } else if (line.align === "center" && credit.test(line.text) && stage === "title" && values.Title) {
      stage = "credit";
      add("Credit", line.text);
    } else if (line.align !== "left" && date.test(line.text) && !values["Draft date"]) add("Draft date", line.text);
    else if (line.align === "center") {
      // A gap of two or more blank lines ends the title and starts the authors when there is no credit line.
      if (stage === "title" && values.Title && line.row - lastRow > 2) stage = "author";
      if (stage === "credit") stage = "author";
      add(stage === "title" ? "Title" : stage === "author" ? "Author" : "Source", line.text);
    } else add("Contact", line.text);
    lastRow = line.row;
  }
  return fieldsOf(values);
}

/**
 * Final Draft TitlePage XML for fields, laid out the standard way (the engine's fdxTitlePageNode, which FDX export
 * also uses for scripts that have no Final Draft title page): title centered a third of the way down, credit and
 * authors below it, the source under them, copyright and notes then contact at the foot on the left, and the
 * draft date at the foot on the right.
 */
export function titlePageNode(fields: readonly TitleField[], page: PageLayout = PAGE): XmlNode {
  const rows = Math.floor((page.height - page.top - page.bottom) * page.linesPerInch + 1e-6);
  return fdxTitlePageNode(fields, rows) ?? { name: "TitlePage", attrs: [], children: [{ name: "Content", attrs: [], children: [] }] };
}

/**
 * FDX extras with the TitlePage rebuilt from fields, keeping the element's other children (its header and
 * footer settings). With no fields the title page is removed.
 */
export function withTitlePage(extras: FdxDocumentExtras, fields: readonly TitleField[]): FdxDocumentExtras {
  const next = structuredClone(extras);
  const generated = fields.length ? titlePageNode(fields) : undefined;
  for (const list of [next.before, next.after]) {
    const index = list.findIndex((node) => node.name === "TitlePage");
    if (index < 0) continue;
    if (!generated) list.splice(index, 1);
    else list[index] = { ...list[index]!, children: [...list[index]!.children.filter((child) => typeof child === "string" || child.name !== "Content"), ...generated.children] };
    return next;
  }
  if (generated) next.after.unshift(generated);
  return next;
}

/** The fields to show for a script: its own, or for an FDX script that has none, those read from its TitlePage. */
export function titleFields(script: Pick<Script, "titlePage" | "fdx">): TitleField[] {
  if (script.titlePage.length) return script.titlePage;
  const node = fdxTitlePage(script);
  return node ? fieldsFromTitlePage(node) : [];
}

// ----- Printed layout --------------------------------------------------------------------------------------

export interface TitleLine {
  runs: Run[];
  /** Left edge in inches, and line number from the top margin. */
  x: number;
  y: number;
}

/** Spaces for a tab: to the next half-inch stop. */
function expandTabs(text: string, charsPerInch: number): string {
  const stop = Math.max(1, Math.round(charsPerInch / 2));
  let out = "";
  for (const char of text) out += char === "\t" ? " ".repeat(stop - (out.length % stop)) : char;
  return out;
}

/**
 * The title page as printed lines, or null when the script has none. Uses Final Draft's TitlePage XML when the
 * script has it, otherwise the standard layout of the fields. Lines that run past the foot are dropped.
 */
export function titlePageLines(script: Pick<Script, "titlePage" | "fdx">, page: PageLayout = PAGE): TitleLine[] | null {
  const raw = fdxTitlePage(script);
  const node = raw && titleParagraphs(raw).some((paragraph) => plain(paragraph).trim()) ? raw
    : script.titlePage.some((field) => field.values.some((value) => value.trim())) ? titlePageNode(script.titlePage, page) : undefined;
  if (!node) return null;
  const rows = Math.floor((page.height - page.top - page.bottom) * page.linesPerInch + 1e-6);
  const cpi = page.charsPerInch;
  const lines: TitleLine[] = [];
  let y = 0;
  for (const paragraph of titleParagraphs(node)) {
    y += paragraph.spaceBefore;
    const runs = paragraph.runs.map((run) => ({ ...run, text: expandTabs(run.text, cpi) }));
    const text = runs.map((run) => run.text).join("");
    const width = Math.max(1, Math.floor((paragraph.right - paragraph.left) * cpi + 1e-6));
    for (const [from, to] of wrap(text, width)) {
      if (y >= rows) return lines;
      const chars = to - from;
      const x = paragraph.align === "center" ? (paragraph.left + paragraph.right - chars / cpi) / 2
        : paragraph.align === "right" ? paragraph.right - chars / cpi : paragraph.left;
      if (chars) lines.push({ runs: slice(runs, from, to), x, y });
      y++;
    }
  }
  return lines.length ? lines : null;
}

function slice(runs: readonly Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const start = Math.max(from, at), end = Math.min(to, at + run.text.length);
    if (end > start) out.push({ ...run, text: run.text.slice(start - at, end - at) });
    at += run.text.length;
  }
  return out;
}
