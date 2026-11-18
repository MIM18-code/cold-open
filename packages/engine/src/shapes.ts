// Shape guards for script data in the shared document. The meta map and the paragraph and run attributes sync between
// co-writers, so anyone holding the write key (or sending a .screenplay file) can set any of them to any JSON value. A
// reader that trusted the shape would throw, and stop Save, Print and Export for every writer. Readers pass what they
// read through these guards, which return a clean value, or undefined for a value of the wrong shape, which readers
// then treat as absent. Where most of a value is fine, only the bad part is dropped. The stored value is never
// rewritten: other clients may run older builds, and a reader only ignores what it cannot use.
import {
  isElementType, MARKS, type FdxDocumentExtras, type FdxParagraphExtras, type Paragraph, type Run, type TitleField, type XmlNode,
} from "./model.ts";
import type { ScreenplayDoc } from "./doc.ts";
import { asXmlAttrs, asXmlNode, isXmlName } from "./xml.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A meta value read through a guard, once per stored object: the meta keeps the object it was given, so a reader gets
 * the same clean object back each time, and caches and views that compare by identity keep working.
 */
export function readOnce<T>(cache: WeakMap<object, T | undefined>, value: unknown, guard: (value: unknown) => T | undefined): T | undefined {
  if (typeof value !== "object" || value === null) return guard(value);
  if (!cache.has(value)) cache.set(value, guard(value));
  return cache.get(value);
}

/** XML nodes without the malformed ones: the same array when all are fine, undefined when it is no array. */
export function asXmlNodes(value: unknown): XmlNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let changed = false;
  const kept: XmlNode[] = [];
  for (const item of value) {
    const node = asXmlNode(item);
    // An undefined element (Yjs sends holes as undefined) equals its own result, so it is checked apart.
    if (node === undefined || node !== item) changed = true;
    if (node) kept.push(node);
  }
  return changed ? kept : (value as XmlNode[]);
}

/**
 * The top-level elements export may write beside its own. The writer emits the root and Content itself, and readers
 * (parseFdx among them) take the first Content, so one stored before it would be read back in place of the script;
 * parseFdx stores neither, except a second Content from a file that has two. Of TitlePage elements only the first
 * counts, as the app reads it; Final Draft writes one.
 */
function topLevel(lists: XmlNode[][]): XmlNode[][] {
  let titlePage = false;
  return lists.map((list) => {
    const kept = list.filter((node) => {
      if (node.name === "Content" || node.name === "FinalDraft") return false;
      if (node.name !== "TitlePage") return true;
      if (titlePage) return false;
      return (titlePage = true);
    });
    return kept.length === list.length ? list : kept;
  });
}

/** The document-level FDX data ("fdx" in meta), or undefined when any of its four lists is not a list. */
export function asFdxExtras(value: unknown): FdxDocumentExtras | undefined {
  if (!isRecord(value)) return undefined;
  const rootAttrs = asXmlAttrs(value.rootAttrs), contentAttrs = asXmlAttrs(value.contentAttrs);
  const nodes = [asXmlNodes(value.before), asXmlNodes(value.after)];
  if (!rootAttrs || !contentAttrs || !nodes[0] || !nodes[1]) return undefined;
  const [before, after] = topLevel(nodes as XmlNode[][]) as [XmlNode[], XmlNode[]];
  // Other keys are left out as well: export clones the whole object.
  const same = rootAttrs === value.rootAttrs && contentAttrs === value.contentAttrs && before === value.before && after === value.after
    && Object.keys(value).length === 4;
  return same ? (value as unknown as FdxDocumentExtras) : { rootAttrs, contentAttrs, before, after };
}

const fdxCache = new WeakMap<object, FdxDocumentExtras | undefined>();

/** The document's own FDX data ("fdx" in meta), or undefined when it has the wrong shape. */
export function storedFdx(doc: ScreenplayDoc): FdxDocumentExtras | undefined {
  return readOnce(fdxCache, doc.meta.get("fdx"), asFdxExtras);
}

/** A paragraph's FDX extras with the fields of the wrong shape left out; undefined when none is left. */
export function asFdxParagraphExtras(value: unknown): FdxParagraphExtras | undefined {
  if (!isRecord(value)) return undefined;
  const out: FdxParagraphExtras = {};
  const attrs = asXmlAttrs(value.attrs);
  if (attrs) out.attrs = attrs;
  if (typeof value.type === "string" || value.type === null) out.type = value.type;
  // Written as the name of the ID attribute.
  if (isXmlName(value.idAttr)) out.idAttr = value.idAttr;
  const before = asXmlNodes(value.before);
  if (before) out.before = before;
  const after = asXmlNodes(value.after);
  if (after) out.after = after;
  if (value.textless === true) out.textless = true;
  const emptyText = asXmlAttrs(value.emptyText);
  if (emptyText) out.emptyText = emptyText;
  const dualWrapper = asXmlNode(value.dualWrapper);
  if (dualWrapper) out.dualWrapper = dualWrapper;
  const kept = Object.entries(out);
  if (!kept.length) return undefined;
  return kept.length === Object.keys(value).length && kept.every(([key, field]) => field === value[key]) ? (value as FdxParagraphExtras) : out;
}

type ParagraphFields = Pick<Paragraph, "sceneId" | "sceneNumber" | "dual" | "alignment" | "startsNewPage" | "depth" | "boneyard" | "fdx">;

/**
 * The deepest section depth; a deeper one reads as this. Neither parser has a limit (Fountain counts the #s, FDX has no
 * sections), and "#" repeated 1e15 times throws, so the cap is set well beyond any real outline.
 */
export const MAX_SECTION_DEPTH = 32;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const flag = (value: unknown) => (value === true ? true : undefined);

// In the order of the paragraph's fields, so a clean paragraph reads back exactly as before.
const FIELDS: { [K in keyof ParagraphFields]-?: (value: unknown) => ParagraphFields[K] } = {
  sceneId: text,
  sceneNumber: text,
  dual: (value) => (isRecord(value) && typeof value.block === "string" && (value.side === 1 || value.side === 2) ? { block: value.block, side: value.side } : undefined),
  alignment: text,
  startsNewPage: flag,
  // Fountain writes one # per level, so it must be a whole number of them, and few enough to write.
  depth: (value) => (Number.isInteger(value) && (value as number) >= 1 ? Math.min(value as number, MAX_SECTION_DEPTH) : undefined),
  boneyard: flag,
  fdx: asFdxParagraphExtras,
};

/** One optional field as a paragraph reads it, or undefined when the value has the wrong shape. */
export function paragraphField<K extends keyof ParagraphFields>(field: K, value: unknown): ParagraphFields[K] {
  return (FIELDS[field] as (value: unknown) => ParagraphFields[K])(value);
}

/** A paragraph's optional fields from its line break's attributes (or stored JSON), the wrong-shaped ones left out. */
export function paragraphFields(attributes: Record<string, unknown>): ParagraphFields {
  const out: Record<string, unknown> = {};
  for (const [field, guard] of Object.entries(FIELDS) as [string, (value: unknown) => unknown][]) {
    const value = guard(attributes[field]);
    if (value !== undefined) out[field] = value;
  }
  return out as ParagraphFields;
}

/** A run stored as JSON, or undefined when it has no text; formatting of the wrong shape is left out. */
export function asRun(value: unknown): Run | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  const run: Run = { text: value.text };
  for (const mark of MARKS) if (value[mark] === true) run[mark] = true;
  if (typeof value.styleExtra === "string") run.styleExtra = value.styleExtra;
  if (value.note === true) run.note = true;
  if (isRecord(value.fdx)) {
    const fdx = Object.entries(value.fdx).filter((entry): entry is [string, string] => isXmlName(entry[0]) && typeof entry[1] === "string");
    if (fdx.length) run.fdx = Object.fromEntries(fdx);
  }
  return run;
}

/** A paragraph stored as JSON (an omitted scene's), or undefined when it has no ID. */
export function asParagraph(value: unknown): Paragraph | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const runs = Array.isArray(value.runs) ? value.runs.map(asRun).filter((run) => run !== undefined) : [];
  return { id: value.id, type: isElementType(value.type) ? value.type : "general", runs, ...paragraphFields(value) };
}

/**
 * The title page fields with string keys and values. A field whose values are not a list is left out, and so is one
 * whose key holds a line break or a colon: no parser makes one, and Fountain would read it as more fields or text.
 */
export function asTitlePage(value: unknown): TitleField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((field): TitleField[] => isRecord(field) && typeof field.key === "string" && !/[\r\n:]/.test(field.key) && Array.isArray(field.values)
    ? [{ key: field.key, values: field.values.filter((line): line is string => typeof line === "string") }]
    : []);
}
