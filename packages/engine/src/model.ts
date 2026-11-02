// The plain-data form of a screenplay. Importers produce it, exporters consume it, and
// ScreenplayDoc converts it to and from the collaborative Yjs document.

import type { TemplateId } from "./template-rules.ts";

export const ELEMENT_TYPES = [
  "sceneHeading", "action", "character", "parenthetical", "dialogue", "transition", "shot",
  "general", "lyrics", "castList", "newAct", "endOfAct",
  // Non-printing elements from Fountain.
  "section", "synopsis", "note",
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const NON_PRINTING: ReadonlySet<ElementType> = new Set(["section", "synopsis", "note"]);

export function isElementType(value: unknown): value is ElementType {
  return typeof value === "string" && (ELEMENT_TYPES as readonly string[]).includes(value);
}

/** A raw XML element kept verbatim so FDX data the model does not understand survives a round trip. */
export interface XmlNode {
  name: string;
  attrs: [string, string][];
  children: (XmlNode | string)[];
}

/** A stretch of text with one set of formatting. */
export interface Run {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strikeout?: true;
  allCaps?: true;
  /** FDX style flags the model has no field for, joined with "+" (Shadow, Superscript and so on). */
  styleExtra?: string;
  /** An inline Fountain [[note]]: kept with the paragraph, never printed. */
  note?: true;
  /** Other FDX Text attributes: Font, Size, Color, Background, RevisionID, TagNumber, AdornmentStyle. */
  fdx?: Record<string, string>;
}

export const MARKS = ["bold", "italic", "underline", "strikeout", "allCaps"] as const;
export type Mark = (typeof MARKS)[number];

/** FDX paragraph data with no model field. Kept so FDX export reproduces what Final Draft wrote. */
export interface FdxParagraphExtras {
  /** Paragraph attributes other than Type, the ID, Number, Alignment and StartsNewPage=Yes. */
  attrs?: [string, string][];
  /** The original FDX Type when it was missing or not one the model knows. */
  type?: string | null;
  /** Spelling of the ID attribute when it was not "id". */
  idAttr?: string;
  /** Child elements before the first Text (usually SceneProperties). */
  before?: XmlNode[];
  /** Child elements after the last Text (usually UserParagraphData). */
  after?: XmlNode[];
  /** The paragraph had no Text element at all. */
  textless?: true;
  /** Attributes of the single empty Text element of an empty paragraph. */
  emptyText?: [string, string][];
  /** On the first paragraph of a dual-dialogue block: the wrapper paragraph with its inner paragraphs removed. */
  dualWrapper?: XmlNode;
}

export interface Paragraph {
  /** Stable for the life of the paragraph. Survives edits, type changes and FDX round trips. */
  id: string;
  type: ElementType;
  runs: Run[];
  /** Stable scene identity, meaningful on scene headings. Defaults to the heading's paragraph ID. */
  sceneId?: string;
  sceneNumber?: string;
  /** Paragraphs inside a dual-dialogue block: which block, and left (1) or right (2) column. */
  dual?: { block: string; side: 1 | 2 };
  /** Paragraph alignment when it was set explicitly ("Center" for centered text). */
  alignment?: string;
  startsNewPage?: true;
  /** Section depth (number of # in Fountain). */
  depth?: number;
  /** A note that came from a Fountain boneyard (commented-out text) rather than [[ ]]. */
  boneyard?: true;
  fdx?: FdxParagraphExtras;
}

export interface TitleField {
  key: string;
  values: string[];
}

export interface FdxDocumentExtras {
  rootAttrs: [string, string][];
  contentAttrs: [string, string][];
  /** Top-level elements before and after Content, in order. TitlePage, ElementSettings, PageLayout and the rest. */
  before: XmlNode[];
  after: XmlNode[];
}

export interface Script {
  titlePage: TitleField[];
  paragraphs: Paragraph[];
  fdx?: FdxDocumentExtras;
  /** The document template whose page rules and scene numbering this script follows. */
  template?: TemplateId;
}

export function plainText(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join("");
}

export function sameFormatting(a: Run, b: Run): boolean {
  if (MARKS.some((mark) => a[mark] !== b[mark]) || a.styleExtra !== b.styleExtra || a.note !== b.note) return false;
  const af = a.fdx ?? {}, bf = b.fdx ?? {};
  const keys = Object.keys(af);
  return keys.length === Object.keys(bf).length && keys.every((key) => af[key] === bf[key]);
}

/** Drop empty runs and join neighbours with the same formatting. */
export function normalizeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out.at(-1);
    if (last && sameFormatting(last, run)) last.text += run.text;
    else out.push({ ...run, ...(run.fdx ? { fdx: { ...run.fdx } } : {}) });
  }
  return out;
}

export interface Scene {
  sceneId: string;
  headingId: string;
  heading: string;
  number?: string;
  /** Index of the heading in the paragraph list, and one past the scene's last paragraph. */
  start: number;
  end: number;
  paragraphIds: string[];
}

/** Scenes in script order. Paragraphs before the first heading belong to no scene. */
export function scenesOf(paragraphs: readonly Paragraph[]): Scene[] {
  const scenes: Scene[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.type === "sceneHeading") {
      const last = scenes.at(-1);
      if (last) last.end = index;
      scenes.push({
        sceneId: paragraph.sceneId ?? paragraph.id, headingId: paragraph.id, heading: plainText(paragraph.runs),
        ...(paragraph.sceneNumber !== undefined ? { number: paragraph.sceneNumber } : {}),
        start: index, end: paragraphs.length, paragraphIds: [],
      });
    }
    scenes.at(-1)?.paragraphIds.push(paragraph.id);
  });
  return scenes;
}
