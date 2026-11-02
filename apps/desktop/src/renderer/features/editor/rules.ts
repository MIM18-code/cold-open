// Final Draft's writing rules, as plain functions the editor and its tests share: which element comes
// next on Enter and Tab, caps and parentheses as the writer types, SmartType suggestions, dual dialogue,
// find, and what to say when co-writers' changes left text in the script twice. Nothing here touches the
// DOM or the app object.
import { ELEMENT_LAYOUT, newId, plainText, type ElementType, type Paragraph, type RepairReport } from "@screenplay/engine";

export const ELEMENT_LABELS: Record<ElementType, string> = {
  sceneHeading: "Scene Heading", action: "Action", character: "Character", parenthetical: "Parenthetical",
  dialogue: "Dialogue", transition: "Transition", shot: "Shot", general: "General", lyrics: "Lyrics",
  castList: "Cast List", newAct: "New Act", endOfAct: "End of Act", section: "Section", synopsis: "Synopsis", note: "Note",
};

/** Format menu shortcuts, Final Draft's mapping: Cmd+1 to Cmd+9, and Cmd+0 for General. */
export const ELEMENT_SHORTCUTS: [ElementType, string][] = [
  ["sceneHeading", "1"], ["action", "2"], ["character", "3"], ["parenthetical", "4"], ["dialogue", "5"],
  ["transition", "6"], ["shot", "7"], ["castList", "8"], ["lyrics", "9"], ["general", "0"],
];

/** The element Enter starts after each element, at the end of a paragraph. A setting can override any of them. */
export const DEFAULT_NEXT: Record<ElementType, ElementType> = {
  sceneHeading: "action", action: "action", character: "dialogue", parenthetical: "dialogue", dialogue: "action",
  transition: "sceneHeading", shot: "action", general: "general", lyrics: "lyrics", castList: "castList",
  newAct: "sceneHeading", endOfAct: "newAct", section: "sceneHeading", synopsis: "action", note: "action",
};

/** Enter on an empty paragraph of these types changes its type instead of starting a new paragraph. */
export const EMPTY_ENTER: Partial<Record<ElementType, ElementType>> = {
  character: "action", dialogue: "action", parenthetical: "dialogue",
};

export function nextElement(type: ElementType, overrides: Partial<Record<ElementType, ElementType>> = {}): ElementType {
  return overrides[type] ?? DEFAULT_NEXT[type];
}

/**
 * What Tab and Shift-Tab do. "Empty" means the paragraph has no text.
 *
 *   Element        Tab                                   Shift-Tab
 *   Scene Heading  empty: Action                         empty: Transition
 *   Action         empty: Character                      empty: Scene Heading
 *   Character      empty: Transition                     empty: Action
 *   Parenthetical  go to Dialogue (an empty one or "()"  go to Dialogue
 *                  turns into Dialogue)
 *   Dialogue       insert a Parenthetical "()" with the  empty: Character
 *                  caret inside
 *   Transition     empty: Scene Heading                  empty: Character
 *   Shot           empty: Action                         empty: Scene Heading
 *   anything else  empty: Action                         nothing
 *
 * Anything not listed does nothing, and Tab never moves focus out of the script.
 */
export type TabAction = { kind: "setType"; type: ElementType } | { kind: "parenthetical" } | { kind: "dialogue" };

const TAB_EMPTY: Partial<Record<ElementType, ElementType>> = {
  sceneHeading: "action", action: "character", character: "transition", transition: "sceneHeading", shot: "action",
};
const SHIFT_TAB_EMPTY: Partial<Record<ElementType, ElementType>> = {
  sceneHeading: "transition", action: "sceneHeading", character: "action", dialogue: "character", transition: "character", shot: "sceneHeading",
};

export function tabAction(type: ElementType, empty: boolean, shift: boolean): TabAction | null {
  if (type === "parenthetical") return { kind: "dialogue" };
  if (!shift && type === "dialogue") return { kind: "parenthetical" };
  if (!empty) return null;
  const target = shift ? SHIFT_TAB_EMPTY[type] : (TAB_EMPTY[type] ?? "action");
  return target && target !== type ? { kind: "setType", type: target } : null;
}

export function isCaps(type: ElementType): boolean {
  return ELEMENT_LAYOUT[type].caps;
}

/** Text as it is stored when typed into an element: caps elements store uppercase, as Final Draft does. */
export function typedText(type: ElementType, text: string): string {
  return isCaps(type) ? text.toUpperCase() : text;
}

/**
 * Typing in a parenthetical keeps it wrapped in parentheses. Returns what to insert where and where the
 * caret goes, or null to insert normally.
 */
export function parentheticalInput(text: string, offset: number, typed: string): { insert: string; at: number; caret: number } | null {
  if (!text) {
    const inner = typed === "(" || typed === ")" ? "" : typed;
    return { insert: `(${inner})`, at: 0, caret: 1 + inner.length };
  }
  if (typed === ")" && text[offset] === ")") return { insert: "", at: offset, caret: offset + 1 };
  if (typed === "(" && offset === 0 && text.startsWith("(")) return { insert: "", at: 0, caret: 1 };
  return null;
}

/**
 * How Enter reads a paragraph: whether it counts as empty and whether the caret is at its end. A
 * parenthetical's closing parenthesis is part of the element, not text: "()" is empty, and a caret just
 * before the ")" is at the end, so Enter moves on to dialogue instead of splitting the parentheses apart.
 */
export function enterContext(type: ElementType, text: string, offset: number): { empty: boolean; atEnd: boolean } {
  if (type !== "parenthetical") return { empty: !text, atEnd: offset >= text.length };
  return { empty: /^\s*\(?\s*\)?\s*$/.test(text), atEnd: /^\s*\)?\s*$/.test(text.slice(offset)) };
}

export function wrapParenthetical(text: string): string {
  const inner = text.trim();
  if (!inner) return "()";
  return `${inner.startsWith("(") ? "" : "("}${inner}${inner.endsWith(")") ? "" : ")"}`;
}

export function unwrapParenthetical(text: string): string {
  const match = /^\s*\((.*)\)\s*$/s.exec(text);
  return match ? match[1]! : text;
}

// SmartType.

export const SCENE_PREFIXES = ["INT. ", "EXT. ", "INT./EXT. ", "I/E "];
export const SCENE_TIMES = ["DAY", "NIGHT", "CONTINUOUS", "LATER", "MORNING", "EVENING", "MOMENTS LATER", "SAME"];
export const TRANSITIONS = ["CUT TO:", "DISSOLVE TO:", "SMASH CUT TO:", "MATCH CUT TO:", "FADE OUT.", "FADE TO BLACK.", "FADE IN:"];
export const EXTENSIONS = ["(V.O.)", "(O.S.)", "(O.C.)", "(CONT'D)"];
const PREFIX = /^(INT\.\/EXT\.|EXT\.\/INT\.|I\/E\.?|INT\.|EXT\.|EST\.)\s+/i;

/** A SmartType popup: replace text[from, to) with the chosen item. */
export interface Suggestions {
  from: number;
  to: number;
  items: string[];
}

function byFrequency(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

export function characterNames(paragraphs: readonly Paragraph[]): string[] {
  return byFrequency(paragraphs.filter((p) => p.type === "character")
    .map((p) => plainText(p.runs).replace(/\(.*$/, "").replace(/\^\s*$/, "").trim().toUpperCase()));
}

function headingParts(text: string): { prefix: string; location: string; time: string | null } | null {
  const match = PREFIX.exec(text);
  if (!match) return null;
  const rest = text.slice(match[0].length);
  const dash = rest.lastIndexOf(" - ");
  return dash < 0 ? { prefix: match[0], location: rest, time: null } : { prefix: match[0], location: rest.slice(0, dash), time: rest.slice(dash + 3) };
}

export function sceneLocations(paragraphs: readonly Paragraph[]): string[] {
  return byFrequency(paragraphs.filter((p) => p.type === "sceneHeading")
    .map((p) => headingParts(plainText(p.runs).toUpperCase())?.location.trim() ?? ""));
}

function sceneTimes(paragraphs: readonly Paragraph[]): string[] {
  const seen = paragraphs.filter((p) => p.type === "sceneHeading").map((p) => headingParts(plainText(p.runs).toUpperCase())?.time?.trim() ?? "");
  return [...new Set([...SCENE_TIMES, ...byFrequency(seen)])];
}

function matching(items: string[], typed: string, limit = 8): string[] {
  const upper = typed.toUpperCase();
  return items.filter((item) => item.toUpperCase().startsWith(upper) && item.toUpperCase().trim() !== upper.trim()).slice(0, limit);
}

/** Suggestions for the caret at `offset` in a paragraph, or null. Only offered at the end of the paragraph. */
export function suggestions(type: ElementType, text: string, offset: number, paragraphs: readonly Paragraph[], profile?: unknown): Suggestions | null {
  const custom = profile && typeof profile === "object" ? profile as Record<string, unknown> : {};
  const list = (key: string) => Array.isArray(custom[key]) ? (custom[key] as unknown[]).filter((s): s is string => typeof s === "string").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0,250) : [];
  const excluded = new Set(list("excluded"));
  const combined = (key: string, defaults: string[]) => [...new Set([...list(key), ...defaults])].filter((value) => !excluded.has(value.trim().toUpperCase()));
  if (offset !== text.length) return null;
  const result = (from: number, items: string[]) => (items.length ? { from, to: text.length, items } : null);
  if (type === "character") {
    const paren = text.lastIndexOf("(");
    if (paren >= 0) return result(paren, matching(combined("extensions", EXTENSIONS), text.slice(paren)));
    if (!text.trim()) return null;
    return result(0, matching(combined("names", characterNames(paragraphs)), text));
  }
  if (type === "transition") return text.trim() ? result(0, matching(combined("transitions", TRANSITIONS), text)) : null;
  if (type !== "sceneHeading" || !text) return null;
  const parts = headingParts(text);
  if (!parts) return /\s/.test(text) ? null : result(0, matching(SCENE_PREFIXES, text));
  if (parts.time !== null) return result(text.length - parts.time.length, matching(combined("times", sceneTimes(paragraphs)), parts.time));
  if (!parts.location.trim()) return null;
  return result(parts.prefix.length, matching(combined("locations", sceneLocations(paragraphs)), parts.location).map((location) => `${location} - `));
}

// Dual dialogue.

/** A character cue with the parentheticals and dialogue under it: paragraph indexes [start, end). */
export interface DialogueBlock {
  start: number;
  end: number;
}

const SPEECH: ReadonlySet<ElementType> = new Set(["parenthetical", "dialogue", "lyrics"]);

export function dialogueBlockAt(paragraphs: readonly Paragraph[], index: number): DialogueBlock | null {
  if (index < 0 || index >= paragraphs.length) return null;
  let start = index;
  while (start > 0 && SPEECH.has(paragraphs[start]!.type)) start--;
  if (paragraphs[start]?.type !== "character") return null;
  let end = start + 1;
  while (end < paragraphs.length && SPEECH.has(paragraphs[end]!.type)) end++;
  return index < end ? { start, end } : null;
}

/**
 * Make Dual Dialogue: the dual fields to set for the caret or selection over paragraphs [from, to].
 * Inside a dual block it turns the block off. Otherwise it pairs the block at `from` with the block
 * that follows it (or, with only a caret, the one before it). Null when there is no pair.
 */
export function dualDialogueChanges(paragraphs: readonly Paragraph[], from: number, to: number): { id: string; dual: Paragraph["dual"] }[] | null {
  const current = paragraphs[from];
  if (current?.dual) {
    const block = current.dual.block;
    return paragraphs.filter((p) => p.dual?.block === block).map((p) => ({ id: p.id, dual: undefined }));
  }
  const first = dialogueBlockAt(paragraphs, from);
  if (!first) return null;
  let second = dialogueBlockAt(paragraphs, first.end);
  let pair = second ? [first, second] : null;
  if (!pair && to <= first.end - 1 && first.start > 0) {
    const before = dialogueBlockAt(paragraphs, first.start - 1);
    if (before && before.end === first.start) pair = [before, first];
  }
  if (!pair || pair.some((block) => paragraphs.slice(block.start, block.end).some((p) => p.dual))) return null;
  const block = newId();
  return pair.flatMap((range, side) => paragraphs.slice(range.start, range.end).map((p) => ({ id: p.id, dual: { block, side: (side + 1) as 1 | 2 } })));
}

// Find.

export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export interface Match {
  paragraphId: string;
  from: number;
  to: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findMatches(paragraphs: readonly Paragraph[], query: string, options: FindOptions): Match[] {
  if (!query) return [];
  const body = escapeRegExp(query);
  const pattern = new RegExp(options.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, options.matchCase ? "gu" : "giu");
  const matches: Match[] = [];
  for (const paragraph of paragraphs) {
    const text = plainText(paragraph.runs);
    for (const match of text.matchAll(pattern)) matches.push({ paragraphId: paragraph.id, from: match.index, to: match.index + match[0].length });
  }
  return matches;
}

/** What to tell the writer after the document kept two copies of something; null when it only filled in a missing ID. */
export function repairMessage(report: RepairReport): string | null {
  const scenes = [...new Set(report.headings.map((heading) => heading.trim() || "an untitled scene"))];
  if (scenes.length) {
    const names = scenes.length === 1 ? `"${scenes[0]}"` : `${scenes.length} scenes (${scenes.map((name) => `"${name}"`).join(", ")})`;
    return `Co-writers moved ${names} at the same time, so the script has two copies. Nothing was deleted: remove the copy you don't want.`;
  }
  if (report.copies.length) return "A co-writer's change left some text in the script twice. Nothing was deleted: remove the copy you don't want.";
  return null;
}
