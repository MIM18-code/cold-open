// The ProseMirror document the editor draws. It is a view of the ScreenplayDoc, rebuilt paragraph by
// paragraph from the engine, never the source of truth. Top-level nodes are paragraphs, except a dual
// dialogue block, which is a `dual` node holding a left and a right column of paragraphs.
import type { ElementType, Paragraph, Run } from "@screenplay/engine";
import { Fragment, Mark, Schema, type Node as PMNode } from "prosemirror-model";

const markSpec = (tag: string, className?: string) => ({
  toDOM: () => [tag, className ? { class: className } : {}, 0] as const,
});

export const schema = new Schema({
  nodes: {
    doc: { content: "(paragraph | dual)+" },
    dual: {
      content: "column column",
      attrs: { block: { default: "" } },
      isolating: true,
      toDOM: () => ["div", { class: "editor-dual" }, 0],
    },
    column: {
      content: "paragraph*",
      attrs: { side: { default: 1 } },
      isolating: true,
      toDOM: (node) => ["div", { class: `editor-column editor-column-${node.attrs.side}` }, 0],
    },
    paragraph: {
      content: "(text | softBreak)*",
      marks: "_",
      attrs: { id: { default: "" }, type: { default: "action" }, sceneNumber: { default: null }, alignment: { default: null }, depth: { default: null } },
      toDOM: (node) => {
        const attrs: Record<string, string> = { class: `editor-p editor-t-${node.attrs.type}`, "data-id": node.attrs.id };
        if (node.attrs.sceneNumber) attrs["data-scene-number"] = node.attrs.sceneNumber;
        if (node.attrs.depth) attrs["data-depth"] = String(node.attrs.depth);
        const align = String(node.attrs.alignment ?? "").toLowerCase();
        if (align === "center" || align === "right") attrs.style = `text-align: ${align}`;
        return ["p", attrs, 0];
      },
    },
    softBreak: { inline: true, selectable: false, leafText: () => "\n", toDOM: () => ["br"] },
    text: { inline: true },
  },
  marks: {
    bold: markSpec("strong"),
    italic: markSpec("em"),
    underline: markSpec("u"),
    strikeout: markSpec("s"),
    allCaps: markSpec("span", "editor-allcaps"),
    note: markSpec("span", "editor-note"),
  },
});

const DISPLAY_MARKS = ["bold", "italic", "underline", "strikeout", "allCaps", "note"] as const;
type DisplayMark = (typeof DISPLAY_MARKS)[number];
const markCache = new Map<string, readonly Mark[]>();

function runMarks(run: Run): readonly Mark[] {
  const names = DISPLAY_MARKS.filter((mark) => run[mark]);
  const key = names.join("+");
  let marks = markCache.get(key);
  if (!marks) markCache.set(key, (marks = Mark.setFrom(names.map((name) => schema.mark(name)))));
  return marks;
}

export function paragraphNode(paragraph: Paragraph): PMNode {
  const content: PMNode[] = [];
  for (const run of paragraph.runs) {
    for (const part of run.text.split(/(\n)/)) {
      if (part === "\n") content.push(schema.nodes.softBreak!.create());
      else if (part) content.push(schema.text(part, runMarks(run)));
    }
  }
  return schema.nodes.paragraph!.create({
    id: paragraph.id, type: paragraph.type, sceneNumber: paragraph.sceneNumber ?? null,
    alignment: paragraph.alignment ?? null, depth: paragraph.depth ?? null,
  }, content);
}

/** Top-level nodes for consecutive paragraphs: one per paragraph, one `dual` node per dual-dialogue block. */
export function topNodes(paragraphs: readonly Paragraph[]): PMNode[] {
  const nodes: PMNode[] = [];
  for (let i = 0; i < paragraphs.length; ) {
    const first = paragraphs[i]!;
    if (!first.dual) {
      nodes.push(paragraphNode(first));
      i++;
      continue;
    }
    let j = i;
    while (j < paragraphs.length && paragraphs[j]!.dual?.block === first.dual.block) j++;
    const group = paragraphs.slice(i, j);
    const column = (side: 1 | 2) => schema.nodes.column!.create({ side }, group.filter((p) => p.dual!.side === side).map(paragraphNode));
    nodes.push(schema.nodes.dual!.create({ block: first.dual.block }, [column(1), column(2)]));
    i = j;
  }
  return nodes;
}

export function buildDoc(paragraphs: readonly Paragraph[]): PMNode {
  return schema.nodes.doc!.create(null, Fragment.from(topNodes(paragraphs)));
}

/** How many script paragraphs a top-level node holds. */
export function paragraphCount(node: PMNode): number {
  return node.type === schema.nodes.dual ? node.child(0).childCount + node.child(1).childCount : 1;
}

/** Whether two engine paragraphs draw the same. */
export function sameDisplay(a: Paragraph, b: Paragraph): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.type !== b.type || a.sceneNumber !== b.sceneNumber || a.alignment !== b.alignment || a.depth !== b.depth) return false;
  if (a.dual?.block !== b.dual?.block || a.dual?.side !== b.dual?.side || a.runs.length !== b.runs.length) return false;
  return a.runs.every((run, i) => {
    const other = b.runs[i]!;
    return run.text === other.text && DISPLAY_MARKS.every((mark: DisplayMark) => !run[mark] === !other[mark]);
  });
}

/** Where every paragraph node starts (the position just before it). */
export function paragraphPositions(doc: PMNode): Map<string, number> {
  const positions = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.paragraph) return true;
    if (!positions.has(node.attrs.id)) positions.set(node.attrs.id, pos);
    return false;
  });
  return positions;
}

/**
 * The engine body offset of a document position: every paragraph counts as one line break plus its text,
 * the same as the ScreenplayDoc's Y.Text. A position between paragraphs reads as the next paragraph's
 * line break. Valid while the drawing matches the engine (dual columns drawn in engine order).
 */
export function bodyIndexOf(doc: PMNode, pos: number): number {
  let index = 0;
  let result = -1;
  doc.descendants((node, start) => {
    if (result >= 0) return false;
    if (node.type !== schema.nodes.paragraph) return true;
    if (pos <= start) result = index;
    else if (pos < start + node.nodeSize) result = index + 1 + (pos - start - 1);
    else index += 1 + node.content.size;
    return false;
  });
  return result >= 0 ? result : index;
}

/** One unit of script content between two document positions: a character, or the line break that starts a paragraph. */
export type Token = { char: string; marks: string } | { type: ElementType };

export function tokensBetween(doc: PMNode, from: number, to: number): Token[] {
  const tokens: Token[] = [];
  if (to <= from) return tokens;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type !== schema.nodes.paragraph) return true;
    if (pos >= from && pos < to) tokens.push({ type: node.attrs.type });
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      const a = Math.max(start, from), b = Math.min(start + child.nodeSize, to);
      if (b <= a) return;
      const marks = child.marks.map((mark) => mark.type.name).sort().join("+");
      if (child.isText) for (let i = a - start; i < b - start; i++) tokens.push({ char: child.text![i]!, marks });
      else tokens.push({ char: "\n", marks });
    });
    return false;
  });
  return tokens;
}

export function sameToken(a: Token, b: Token): boolean {
  if ("type" in a) return "type" in b && a.type === b.type;
  return "char" in b && a.char === b.char && a.marks === b.marks;
}
