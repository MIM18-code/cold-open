// Canonical form of an FDX tree for round-trip comparison. Differences it hides are ones Final Draft
// does not care about: attribute order, layout whitespace, the order of style flags, a Text element
// split into neighbours with identical formatting, and empty Text elements beside real ones.
import { parseXml } from "../src/xml.ts";
import type { XmlNode } from "../src/model.ts";

const ID_ATTRS = new Set(["id", "Id", "ID"]);

export interface CanonicalOptions {
  /** Leave paragraph ID attributes out (the importer replaces duplicate or malformed IDs). */
  ignoreIds?: boolean;
}

function canonicalAttrs(node: XmlNode, options: CanonicalOptions): [string, string][] {
  return node.attrs
    .filter(([name]) => !(options.ignoreIds && node.name === "Paragraph" && ID_ATTRS.has(name)))
    .map(([name, value]): [string, string] => [name, node.name === "Text" && name === "Style" ? value.split("+").filter(Boolean).sort().join("+") : value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function canonical(node: XmlNode, options: CanonicalOptions = {}): XmlNode {
  let children = node.children.map((child) => (typeof child === "string" ? child : canonical(child, options)));
  if (node.name === "Paragraph") {
    const texts = children.filter((child): child is XmlNode => typeof child !== "string" && child.name === "Text");
    const nonEmpty = texts.filter((text) => text.children.join("") !== "");
    if (nonEmpty.length) children = children.filter((child) => typeof child === "string" || child.name !== "Text" || nonEmpty.includes(child));
    else if (texts.length > 1) children = children.filter((child) => typeof child === "string" || child.name !== "Text" || child === texts[0]);
    const merged: (XmlNode | string)[] = [];
    for (const child of children) {
      const last = merged.at(-1);
      if (typeof child !== "string" && child.name === "Text" && typeof last !== "string" && last?.name === "Text"
        && JSON.stringify(last.attrs) === JSON.stringify(child.attrs)) {
        last.children = [last.children.join("") + child.children.join("")];
      } else {
        merged.push(typeof child === "string" ? child : { ...child, children: [...child.children] });
      }
    }
    children = merged;
  }
  if (node.name === "Text") children = [children.join("")].filter(Boolean);
  return { name: node.name, attrs: canonicalAttrs(node, options), children };
}

export function canonicalFdx(source: string, options: CanonicalOptions = {}): string {
  return JSON.stringify(canonical(parseXml(source), options));
}

/** First differing path between two canonical trees, for readable failures. */
export function firstDifference(a: XmlNode | string, b: XmlNode | string, path = ""): string | undefined {
  if (typeof a === "string" || typeof b === "string") return a === b ? undefined : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  const here = `${path}/${a.name}`;
  if (a.name !== b.name) return `${here}: element ${a.name} vs ${b.name}`;
  if (JSON.stringify(a.attrs) !== JSON.stringify(b.attrs)) return `${here}: attrs ${JSON.stringify(a.attrs)} vs ${JSON.stringify(b.attrs)}`;
  for (let i = 0; i < Math.max(a.children.length, b.children.length); i++) {
    const x = a.children[i], y = b.children[i];
    if (x === undefined || y === undefined) return `${here}[${i}]: missing child (${x === undefined ? "left" : "right"})`;
    const found = firstDifference(x, y, `${here}[${i}]`);
    if (found) return found;
  }
  return undefined;
}
