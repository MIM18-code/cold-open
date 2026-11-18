// A small XML tree reader and writer for FDX. Keeps attribute order and every character of text
// content. Whitespace-only text between elements is layout, so it is dropped on read.
//
// XML 1.0 forbids some characters outright (most C0 controls, lone surrogates, U+FFFE and U+FFFF), even as
// character references. Text pasted from elsewhere can hold them, and a file that contains one does not open in
// Final Draft or here. The writer never writes them; the reader drops them from a file that has them. Vertical tab
// and form feed (line and page breaks in other programs) become a space so the words either side stay apart.
import { SaxesParser } from "saxes";

import type { XmlNode } from "./model.ts";

export class XmlError extends Error {}

const DISALLOWED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CHARACTER_REFERENCE = /&#(?:x([0-9A-Fa-f]+)|([0-9]+));/g;

const allowedCode = (code: number) =>
  code === 0x9 || code === 0xA || code === 0xD || (code >= 0x20 && code <= 0xD7FF) || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF);
const replacement = (code: number) => (code === 0xB || code === 0xC ? " " : "");

/** Text with the characters XML 1.0 cannot hold replaced (vertical tab and form feed) or removed (the rest). */
export function xmlSafe(value: string): string {
  return value.replace(DISALLOWED, (character) => replacement(character.charCodeAt(0)));
}

/** The characters in a tree's text and attribute values that XML 1.0 cannot hold, as "U+000B" codes. */
export function disallowedCharacters(node: XmlNode): string[] {
  const found: string[] = [];
  const scan = (value: string) => {
    for (const match of value.match(DISALLOWED) ?? []) found.push(`U+${match.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
  };
  // Only what serializeXml writes.
  const walk = (current: XmlNode) => {
    if (!isNodeShape(current)) return;
    for (const pair of current.attrs) if (isXmlAttr(pair)) scan(pair[1]);
    for (const child of current.children) {
      if (typeof child === "string") scan(child);
      else walk(child);
    }
  };
  walk(node);
  return found;
}

export interface XmlReadOptions {
  /** Receives one message per repair: characters XML does not allow, or text after the root element. */
  warnings?: string[];
}

const LITERAL_SPANS = /(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)/;

/** The source with characters XML 1.0 does not allow (raw or as character references) dropped; and how many. */
function cleanSource(source: string): { source: string; removed: number } {
  let removed = 0;
  const cleaned = source
    .replace(DISALLOWED, (character) => {
      removed++;
      return replacement(character.charCodeAt(0));
    })
    // Inside CDATA and comments "&#1;" is literal text, not a reference, so those spans are left alone.
    .split(LITERAL_SPANS)
    .map((part, index) => index % 2 ? part : part.replace(CHARACTER_REFERENCE, (reference, hex: string | undefined, decimal: string | undefined) => {
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal!, 10);
      if (allowedCode(code)) return reference;
      removed++;
      return replacement(code);
    }))
    .join("");
  return { source: cleaned, removed };
}

export function parseXml(source: string, options: XmlReadOptions = {}): XmlNode {
  const parser = new SaxesParser({ xmlns: false, position: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let failure: Error | undefined;
  // Where the root element closed. Anything after it but whitespace is not XML; some files have the end of an
  // older, longer write left there, and it is ignored.
  let end: number | undefined;
  parser.on("error", (error) => {
    if (end === undefined) failure ??= error;
  });
  parser.on("doctype", () => { failure ??= new XmlError("DOCTYPE declarations are not accepted."); });
  parser.on("opentag", (tag) => {
    if (end !== undefined) return;
    const node: XmlNode = { name: tag.name, attrs: Object.entries(tag.attributes as Record<string, string>), children: [] };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) failure ??= new XmlError("More than one root element.");
    else root = node;
    stack.push(node);
  });
  parser.on("closetag", () => {
    if (end !== undefined) return;
    const node = stack.pop()!;
    if (node.children.some((child) => typeof child !== "string")) {
      node.children = node.children.filter((child) => typeof child !== "string" || /\S/.test(child));
    }
    if (!stack.length) end = parser.position;
  });
  const addText = (text: string) => {
    const parent = stack.at(-1);
    if (!parent || end !== undefined) return;
    const last = parent.children.at(-1);
    if (typeof last === "string") parent.children[parent.children.length - 1] = last + text;
    else parent.children.push(text);
  };
  parser.on("text", addText);
  parser.on("cdata", addText);
  const cleaned = cleanSource(source.replace(/^﻿/, ""));
  parser.write(cleaned.source).close();
  if (failure) throw failure instanceof XmlError ? failure : new XmlError(failure.message);
  if (!root) throw new XmlError("No root element.");
  if (cleaned.removed) {
    options.warnings?.push(`Removed ${cleaned.removed} control character${cleaned.removed === 1 ? "" : "s"} that XML does not allow.`);
  }
  const trailing = end === undefined ? 0 : cleaned.source.slice(end).trim().length;
  if (trailing) options.warnings?.push(`Ignored ${trailing} character${trailing === 1 ? "" : "s"} after the end of the document (</${root.name}>).`);
  return root;
}

function escapeText(value: string): string {
  return xmlSafe(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}

// ----- Names and shapes ------------------------------------------------------------------------------------
//
// Trees kept in the shared document (the raw FDX in meta, paragraph extras, "fdx:" run attributes) can be written by
// any co-writer with any JSON shape, and their element and attribute names go into the file unescaped. A name that is
// not an XML name would inject markup or make a file Final Draft cannot open, so these checks run when such a tree is
// read and again when one is written.

// XML 1.0 (fifth edition) Name, which is what saxes accepts.
const XML_NAME = /^[:A-Z_a-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\u{10000}-\u{EFFFF}][:A-Z_a-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�\u{10000}-\u{EFFFF}\-.0-9·̀-ͯ‿-⁀]*$/u;

export function isXmlName(value: unknown): value is string {
  return typeof value === "string" && XML_NAME.test(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isXmlAttr = (pair: unknown): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && isXmlName(pair[0]) && typeof pair[1] === "string";
const isNodeShape = (value: unknown): value is XmlNode =>
  isRecord(value) && isXmlName(value.name) && Array.isArray(value.attrs) && Array.isArray(value.children);

/** Attribute pairs without the malformed ones: the same array when all are fine, undefined when it is no array. */
export function asXmlAttrs(value: unknown): [string, string][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = value.filter(isXmlAttr);
  return kept.length === value.length ? (value as [string, string][]) : kept;
}

/**
 * How deep a stored tree may nest. Final Draft nests a handful of levels; a co-writer's tree a thousand levels deep
 * would overflow the stack in structuredClone and in the writer, so anything below this depth is left out.
 */
export const MAX_XML_DEPTH = 64;

/**
 * A tree without its malformed attributes and children: the same object when nothing is malformed, so caches keyed on
 * it keep working. Undefined when the node itself is malformed (not an object, a bad name, attrs or children not lists)
 * or sits deeper than MAX_XML_DEPTH. Keys other than the three a node has are left out too, since export clones the
 * whole object.
 */
export function asXmlNode(value: unknown, level = 0): XmlNode | undefined {
  if (level >= MAX_XML_DEPTH || !isNodeShape(value)) return undefined;
  const attrs = asXmlAttrs(value.attrs)!;
  let changed = attrs !== value.attrs || Object.keys(value).length !== 3;
  const children: (XmlNode | string)[] = [];
  for (const child of value.children as unknown[]) {
    const clean = typeof child === "string" ? child : asXmlNode(child, level + 1);
    // An undefined child (Yjs sends holes as undefined) equals its own result, so it is checked apart.
    if (clean === undefined || clean !== child) changed = true;
    if (clean !== undefined) children.push(clean);
  }
  return changed ? { name: value.name, attrs, children } : value;
}

/**
 * XML for a tree. Characters XML 1.0 cannot hold are never written (see xmlSafe). Malformed parts are left out rather
 * than written or thrown on: an attribute with a bad name or a value that is not a string, a repeated attribute, a
 * child that is neither text nor a node, and a node with a bad name, with everything inside it. A malformed root
 * gives "".
 */
export function serializeXml(node: XmlNode, indent = ""): string {
  if (!isNodeShape(node)) return "";
  const seen = new Set<string>();
  const attrs = node.attrs
    .filter((pair) => isXmlAttr(pair) && !seen.has(pair[0]) && !!seen.add(pair[0]))
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join("");
  const children = node.children.filter((child) => typeof child === "string" || isNodeShape(child));
  if (!children.length) return `${indent}<${node.name}${attrs}/>`;
  if (children.some((child) => typeof child === "string")) {
    // Text content (or rare mixed content) is written inline so no layout whitespace leaks into it.
    const inner = children.map((child) => typeof child === "string" ? escapeText(child) : serializeXml(child)).join("");
    return `${indent}<${node.name}${attrs}>${inner}</${node.name}>`;
  }
  const inner = children.map((child) => serializeXml(child as XmlNode, `${indent}  `)).join("\n");
  return `${indent}<${node.name}${attrs}>\n${inner}\n${indent}</${node.name}>`;
}

export function attr(node: XmlNode, name: string): string | undefined {
  return node.attrs.find(([key]) => key === name)?.[1];
}

export function textOf(node: XmlNode): string {
  return node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
}

export function cloneNode(node: XmlNode): XmlNode {
  return structuredClone(node);
}
