// Proofreading without a model: names that drift, broken script structure, and plain typing slips.
// Every finding has an ID built from its rule, its paragraph and the text it points at, so the same
// problem gets the same ID on every run and an "ignore" stored in the document keeps working.
import { type Paragraph, plainText } from "./model.ts";

export const FINDING_KINDS = ["name", "structure", "punctuation", "spacing", "repeat", "capital", "spelling", "ai"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDING_KIND_LABELS: Record<FindingKind, string> = {
  name: "Character names",
  structure: "Script structure",
  punctuation: "Punctuation",
  spacing: "Spacing",
  repeat: "Repeated words",
  capital: "Capitals",
  spelling: "Spelling",
  ai: "AI check",
};

export interface Finding {
  /** Stable across runs: derived from the rule, the paragraph and the text. */
  id: string;
  paragraphId: string;
  /** Character offsets into the paragraph's plain text. */
  from: number;
  to: number;
  kind: FindingKind;
  /** Which check found it, for example "name.cue" or "structure.dialogue-without-cue". */
  rule: string;
  message: string;
  /** Text that should replace from..to. Absent when the fix needs the writer. */
  replacement?: string;
  /** Other replacements to offer (spelling suggestions). */
  alternatives?: string[];
}

export interface ProofreadOptions {
  /** Kinds to run. Default: all except spelling and ai, which the app runs itself. */
  kinds?: readonly FindingKind[];
}

/** A small, fast, stable string hash (cyrb53), written in base 36. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function findingId(rule: string, paragraphId: string, text: string, occurrence = 0): string {
  return `${rule}:${hashText(`${paragraphId}\u0000${text}\u0000${occurrence}`)}`;
}

/** Levenshtein distance, counting a swap of two neighbouring letters as one edit. */
export function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows[i] = [i];
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[i]![j] = j;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

// A paragraph's text with inline [[notes]] blanked out, so findings never point into notes. Same length as the paragraph.
export function checkedText(paragraph: Paragraph): string {
  return paragraph.runs.map((run) => (run.note ? "\u0001".repeat(run.text.length) : run.text)).join("");
}

export interface Cue {
  /** The name in capitals, extensions removed: "MAYA". */
  name: string;
  from: number;
  to: number;
  /** Everything after the name, such as " (V.O.)". */
  extension: string;
}

/** Split a character cue into its name and extension. */
export function parseCue(text: string): Cue | null {
  const match = /^(\s*)([^(^]*?)\s*(\^?\s*(?:\(.*)?\^?\s*)$/.exec(text);
  if (!match) return null;
  const name = match[2]!.replace(/\s+/g, " ").trim();
  if (!name) return null;
  const from = match[1]!.length;
  const to = from + match[2]!.length;
  return { name: name.toUpperCase(), from, to, extension: text.slice(to).trimEnd() };
}

const PRINTING = (p: Paragraph) => p.type !== "section" && p.type !== "synopsis" && p.type !== "note";

/** Words in capitals that are never a character's name. */
const NOT_NAMES = new Set([
  "INT", "EXT", "EST", "CUT", "TO", "FADE", "IN", "OUT", "DAY", "NIGHT", "LATER", "CONTINUOUS", "MORNING", "EVENING", "DAWN", "DUSK",
  "SUPER", "TITLE", "THE", "AND", "OF", "ON", "AT", "A", "AN", "FLASHBACK", "INTERCUT", "MONTAGE", "END", "BACK", "SMASH", "MATCH",
  "DISSOLVE", "CONT'D", "V.O.", "O.S.", "O.C.", "POV", "ANGLE", "CLOSE", "WIDE", "INSERT", "SERIES", "SHOTS", "MORE",
]);

interface NameUse {
  paragraphId: string;
  from: number;
  to: number;
  text: string;
  site: "cue" | "action";
}

const CAPS_PHRASE = /(?<![\p{L}\p{N}'’])\p{Lu}[\p{Lu}'’.-]*(?: \p{Lu}[\p{Lu}'’.-]*)*(?![\p{L}\p{N}'’])/gu;

/** Capitalized phrases in action that read like a name, with where they sit. Whole-line capitals are not introductions. */
function actionNames(paragraph: Paragraph, text: string, cueNames: ReadonlyMap<string, string>): { name: string; from: number; to: number }[] {
  if (paragraph.type !== "action" && paragraph.type !== "general") return [];
  if (!/\p{Ll}/u.test(text)) return [];
  const found: { name: string; from: number; to: number }[] = [];
  for (const match of text.matchAll(CAPS_PHRASE)) {
    // A possessive is the same name (MAYA'S car), unless the apostrophe is part of a cue name (BOTTLES').
    const whole = match[0].replace(/[.-]+$/, ""), straight = whole.replace(/’/g, "'");
    const name = cueNames.get(straight) ?? whole.replace(/['’]S?$/u, "");
    const words = name.split(" ").filter((word) => !NOT_NAMES.has(word));
    if (words.length !== name.split(" ").length || name.length < 3 || !/^\p{Lu}{2,}/u.test(name)) continue;
    found.push({ name, from: match.index!, to: match.index! + name.length });
  }
  return found;
}

function isNearDuplicate(rare: string, common: string): boolean {
  if (rare === common || /\d/.test(rare) || /\d/.test(common)) return false;
  // In names of several words, judge the one word that differs on its own: JERRY'S BROTHER is not JERRY'S MOTHER.
  const rareWords = rare.split(" "), commonWords = common.split(" ");
  if (rareWords.length > 1 && rareWords.length === commonWords.length) {
    const differing = rareWords.flatMap((word, i) => (word === commonWords[i] ? [] : [[word, commonWords[i]!] as const]));
    return differing.length > 0 && differing.every(([a, b]) => isNearDuplicate(a, b) || isTransposition(a, b));
  }
  const shortest = Math.min(rare.length, common.length);
  if (shortest < 3) return false;
  const distance = editDistance(rare, common);
  if (distance === 0) return false;
  if (shortest <= 4) {
    // Short names differ by a letter too easily (TOM, TIM): only a dropped or doubled letter counts.
    return distance === 1 && Math.abs(rare.length - common.length) === 1;
  }
  return distance <= (shortest >= 8 ? 2 : 1);
}

/** Two neighbouring letters swapped: DNA for DAN. */
function isTransposition(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 3) return false;
  const at = [...a].findIndex((ch, i) => ch !== b[i]);
  return at >= 0 && at < a.length - 1 && a[at] === b[at + 1] && a[at + 1] === b[at] && a.slice(at + 2) === b.slice(at + 2);
}

function outweighs(commonWeight: number, rareWeight: number): boolean {
  return rareWeight * 3 <= commonWeight || (rareWeight === 1 && commonWeight >= 2);
}

function nameFindings(paragraphs: readonly Paragraph[], texts: readonly string[]): Finding[] {
  const cueCounts = new Map<string, number>();
  const actionCounts = new Map<string, number>();
  const uses: NameUse[] = [];
  // Cue spellings keyed by their straight-apostrophe form, so BOTTLES’ in action matches a BOTTLES' cue.
  const cueNameSet = new Map(paragraphs.flatMap((paragraph, index) => {
    const name = paragraph.type === "character" ? parseCue(texts[index]!)?.name : undefined;
    return name ? [[name.replace(/\u2019/g, "'"), name] as const] : [];
  }));
  paragraphs.forEach((paragraph, index) => {
    const text = texts[index]!;
    if (paragraph.type === "character") {
      const cue = parseCue(text);
      if (!cue) return;
      cueCounts.set(cue.name, (cueCounts.get(cue.name) ?? 0) + 1);
      uses.push({ paragraphId: paragraph.id, from: cue.from, to: cue.to, text: cue.name, site: "cue" });
    } else {
      for (const found of actionNames(paragraph, text, cueNameSet)) {
        actionCounts.set(found.name, (actionCounts.get(found.name) ?? 0) + 1);
        uses.push({ paragraphId: paragraph.id, from: found.from, to: found.to, text: found.name, site: "action" });
      }
    }
  });
  const weight = (name: string) => (cueCounts.get(name) ?? 0) + (actionCounts.get(name) ?? 0);
  const cueNames = [...cueCounts.keys()];
  const allNames = [...new Set([...cueNames, ...actionCounts.keys()])];
  const better = new Map<string, string | null>();
  // A cue may be a slip for a name the writer introduced in action; a name in action only for a known cue.
  const betterName = (name: string, site: NameUse["site"]): string | null => {
    const key = `${site}\u0000${name}`;
    if (better.has(key)) return better.get(key)!;
    let best: string | null = null;
    for (const other of site === "cue" ? allNames : cueNames) {
      if (!isNearDuplicate(name, other) || !outweighs(weight(other), weight(name))) continue;
      const distance = editDistance(name, other);
      const bestDistance = best ? editDistance(name, best) : Infinity;
      if (distance < bestDistance || (distance === bestDistance && weight(other) > weight(best!))) best = other;
    }
    better.set(key, best);
    return best;
  };
  const findings: Finding[] = [];
  const seen = new Map<string, number>();
  for (const use of uses) {
    // An action word that is itself a cue name is a name; only unknown spellings can be typos.
    if (use.site === "action" && cueCounts.has(use.text)) continue;
    const target = betterName(use.text, use.site);
    if (!target) continue;
    const key = `${use.paragraphId}\u0000${use.text}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const where = use.site === "cue" ? "This cue reads" : "The action reads";
    findings.push({
      id: findingId(`name.${use.site}`, use.paragraphId, use.text, n),
      paragraphId: use.paragraphId, from: use.from, to: use.to, kind: "name", rule: `name.${use.site}`,
      message: `${where} ${use.text}, but the script uses ${target} (${weight(target)} times).`,
      replacement: target,
    });
  }
  return findings;
}

const HEADING_PREFIX = /^\s*(INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\/E|INT|EXT|EST)(\.?)(?=[\s/]|$)/i;
const TIME_SEPARATOR = /\s[-–—]\s*\S/;

function headingFindings(paragraph: Paragraph, text: string): Finding[] {
  if (!text.trim()) return [];
  const out: Finding[] = [];
  const prefix = HEADING_PREFIX.exec(text);
  if (!prefix) {
    out.push({ id: findingId("structure.heading-prefix", paragraph.id, text), paragraphId: paragraph.id, from: 0, to: text.length, kind: "structure",
      rule: "structure.heading-prefix", message: "A scene heading starts with INT. or EXT." });
  } else if (!prefix[2] && !/[/]/.test(prefix[1]!)) {
    const start = text.indexOf(prefix[1]!);
    out.push({ id: findingId("structure.heading-period", paragraph.id, text), paragraphId: paragraph.id, from: start, to: start + prefix[1]!.length, kind: "structure",
      rule: "structure.heading-period", message: `Write ${prefix[1]!.toUpperCase()}. with a period.`, replacement: `${prefix[1]!.toUpperCase()}.` });
  }
  if (!TIME_SEPARATOR.test(text)) {
    out.push({ id: findingId("structure.heading-time", paragraph.id, text), paragraphId: paragraph.id, from: 0, to: text.length, kind: "structure",
      rule: "structure.heading-time", message: "This scene heading has no time of day. Add - DAY or - NIGHT." });
  }
  return out;
}

function transitionFindings(paragraph: Paragraph, text: string): Finding[] {
  const trimmed = text.trimEnd();
  if (!trimmed || /[.:]$/.test(trimmed)) return [];
  const last = /\S+$/.exec(trimmed)!;
  const end = last.index + last[0].length;
  const word = last[0];
  const fix = /^to$/i.test(word) || /^in$/i.test(word) ? `${word}:` : `${word}.`;
  return [{ id: findingId("structure.transition", paragraph.id, text), paragraphId: paragraph.id, from: last.index, to: end, kind: "structure",
    rule: "structure.transition", message: "A transition ends with TO: or a period.", replacement: fix }];
}

function dialogueFindings(paragraphs: readonly Paragraph[], texts: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const printing = paragraphs.map((_, i) => i).filter((i) => PRINTING(paragraphs[i]!));
  printing.forEach((index, position) => {
    const paragraph = paragraphs[index]!;
    const text = texts[index]!;
    if (!text.trim()) return;
    const previous = position > 0 ? paragraphs[printing[position - 1]!]!.type : null;
    if ((paragraph.type === "dialogue" || paragraph.type === "parenthetical") && previous !== "character" && previous !== "dialogue" && previous !== "parenthetical") {
      const rule = `structure.${paragraph.type}-without-cue`;
      out.push({ id: findingId(rule, paragraph.id, text), paragraphId: paragraph.id, from: 0, to: text.length, kind: "structure", rule,
        message: `This ${paragraph.type} has no character cue above it.` });
    }
    if (paragraph.type === "character") {
      const next = position + 1 < printing.length ? paragraphs[printing[position + 1]!]! : null;
      // A cue at the end of the script is still being written.
      if (next && next.type !== "dialogue" && next.type !== "parenthetical") {
        out.push({ id: findingId("structure.cue-without-dialogue", paragraph.id, text), paragraphId: paragraph.id, from: 0, to: text.length, kind: "structure",
          rule: "structure.cue-without-dialogue", message: "This character cue has no dialogue after it." });
      }
    }
  });
  return out;
}

/** Unmatched brackets and quotes in one paragraph. */
function punctuationFindings(paragraph: Paragraph, text: string): Finding[] {
  if (paragraph.type === "sceneHeading" || paragraph.type === "transition") return [];
  const out: Finding[] = [];
  const stack: number[] = [];
  const strays: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") stack.push(i);
    else if (text[i] === ")") {
      if (stack.length) stack.pop();
      else strays.push(i);
    }
  }
  const unmatched = [...strays, ...stack].sort((a, b) => a - b);
  unmatched.forEach((at, n) => {
    const opening = text[at] === "(";
    const finding: Finding = {
      id: findingId("punctuation.parenthesis", paragraph.id, text[at]! + text.slice(Math.max(0, at - 8), at), n),
      paragraphId: paragraph.id, from: at, to: at + 1, kind: "punctuation", rule: "punctuation.parenthesis",
      message: opening ? "This parenthesis is never closed." : "This closing parenthesis has no opening one.",
    };
    // A parenthetical that lost its last bracket: close it.
    if (opening && paragraph.type === "parenthetical" && at === text.search(/\S/) && stack.length === 1) {
      const end = text.trimEnd().length;
      finding.from = end - 1;
      finding.to = end;
      finding.replacement = `${text[end - 1]})`;
    }
    out.push(finding);
  });
  const straight = [...text.matchAll(/"/g)].map((m) => m.index!);
  if (straight.length % 2 === 1) {
    const at = straight.at(-1)!;
    out.push({ id: findingId("punctuation.quote", paragraph.id, text.slice(Math.max(0, at - 8), at + 1)), paragraphId: paragraph.id, from: at, to: at + 1,
      kind: "punctuation", rule: "punctuation.quote", message: "This quotation mark has no partner." });
  }
  const opens = [...text.matchAll(/“/g)].map((m) => m.index!);
  const closes = [...text.matchAll(/”/g)].map((m) => m.index!);
  if (opens.length !== closes.length) {
    const at = opens.length > closes.length ? opens.at(-1)! : closes.at(-1)!;
    out.push({ id: findingId("punctuation.curly-quote", paragraph.id, text.slice(Math.max(0, at - 8), at + 1)), paragraphId: paragraph.id, from: at, to: at + 1,
      kind: "punctuation", rule: "punctuation.curly-quote", message: "This quotation mark has no partner." });
  }
  return out;
}

function spacingFindings(paragraph: Paragraph, text: string): Finding[] {
  if (paragraph.type === "sceneHeading" && !text.trim()) return [];
  const out: Finding[] = [];
  const seen = new Map<string, number>();
  for (const match of text.matchAll(/(?<=\S) {2,}(?=\S)/g)) {
    const context = text.slice(Math.max(0, match.index! - 10), match.index!);
    const n = seen.get(context) ?? 0;
    seen.set(context, n + 1);
    out.push({ id: findingId("spacing.double", paragraph.id, context, n), paragraphId: paragraph.id, from: match.index!, to: match.index! + match[0].length,
      kind: "spacing", rule: "spacing.double", message: "Two spaces in a row.", replacement: " " });
  }
  return out;
}

const REPEATABLE = new Set(["the", "a", "an", "and", "of", "to", "in", "is", "it", "was", "for", "on", "with", "as", "at", "by", "this", "be", "are", "or", "but", "not", "from", "have", "his", "her", "their", "my", "your", "its", "if", "so", "we", "he", "she", "they", "you"]);

function repeatFindings(paragraph: Paragraph, text: string): Finding[] {
  if (paragraph.type === "sceneHeading" || paragraph.type === "character" || paragraph.type === "transition") return [];
  const out: Finding[] = [];
  const seen = new Map<string, number>();
  for (const match of text.matchAll(/(?<![\p{L}\p{N}'’-])(\p{L}[\p{L}'’]*)(\s+)\1(?![\p{L}\p{N}'’-])/giu)) {
    const word = match[1]!.toLowerCase();
    if (!REPEATABLE.has(word)) continue;
    const n = seen.get(word) ?? 0;
    seen.set(word, n + 1);
    out.push({ id: findingId("repeat.word", paragraph.id, word, n), paragraphId: paragraph.id, from: match.index!, to: match.index! + match[0].length,
      kind: "repeat", rule: "repeat.word", message: `"${match[1]}" appears twice in a row.`, replacement: match[1]! });
  }
  return out;
}

/** Words that end in a period without ending the sentence. */
const ABBREVIATIONS = /(?:^|[\s("'])(?:mr|mrs|ms|dr|st|jr|sr|vs|etc|no|approx|inc|ltd|co|mt|ft|fig|e\.g|i\.e|a\.m|p\.m|u\.s|u\.k|[\p{L}])\.$/iu;

function capitalFindings(paragraph: Paragraph, text: string): Finding[] {
  if (!["action", "dialogue", "general", "shot", "lyrics"].includes(paragraph.type)) return [];
  const out: Finding[] = [];
  const seen = new Map<string, number>();
  for (const match of text.matchAll(/([.!?])(["')\]”’]*)(\s+)(\p{Ll})/gu)) {
    const before = text.slice(0, match.index! + 1);
    if (match[1] === "." && (before.endsWith("..") || ABBREVIATIONS.test(before))) continue;
    const at = match.index! + match[0].length - 1;
    const context = text.slice(Math.max(0, at - 12), at + 1);
    const n = seen.get(context) ?? 0;
    seen.set(context, n + 1);
    out.push({ id: findingId("capital.sentence", paragraph.id, context, n), paragraphId: paragraph.id, from: at, to: at + 1, kind: "capital",
      rule: "capital.sentence", message: "A sentence starts with a capital letter.", replacement: match[4]!.toUpperCase() });
  }
  return out;
}

const ALL_KINDS: readonly FindingKind[] = ["name", "structure", "punctuation", "spacing", "repeat", "capital"];

/** Run the checks over a script's paragraphs. Findings come back in script order. */
export function proofread(paragraphs: readonly Paragraph[], options: ProofreadOptions = {}): Finding[] {
  const kinds = new Set(options.kinds ?? ALL_KINDS);
  const texts = paragraphs.map(checkedText);
  const findings: Finding[] = [];
  if (kinds.has("name")) findings.push(...nameFindings(paragraphs, texts));
  if (kinds.has("structure")) findings.push(...dialogueFindings(paragraphs, texts));
  paragraphs.forEach((paragraph, index) => {
    const text = texts[index]!;
    if (!PRINTING(paragraph)) return;
    if (kinds.has("structure")) {
      if (paragraph.type === "sceneHeading") findings.push(...headingFindings(paragraph, text));
      if (paragraph.type === "transition") findings.push(...transitionFindings(paragraph, text));
    }
    if (kinds.has("punctuation")) findings.push(...punctuationFindings(paragraph, text));
    if (kinds.has("spacing")) findings.push(...spacingFindings(paragraph, text));
    if (kinds.has("repeat")) findings.push(...repeatFindings(paragraph, text));
    if (kinds.has("capital")) findings.push(...capitalFindings(paragraph, text));
  });
  const order = new Map(paragraphs.map((paragraph, index) => [paragraph.id, index]));
  return findings.sort((a, b) => (order.get(a.paragraphId)! - order.get(b.paragraphId)!) || a.from - b.from);
}

/**
 * Words the spell checker should leave alone: tokens of character names and scene headings (locations)
 * and capitalized words that appear in capitals more than once. Lowercase.
 */
export function scriptVocabulary(paragraphs: readonly Paragraph[]): Set<string> {
  const vocabulary = new Set<string>();
  const capsCounts = new Map<string, number>();
  const tokens = (text: string) => text.match(/\p{L}[\p{L}'’]*/gu) ?? [];
  for (const paragraph of paragraphs) {
    const text = checkedText(paragraph);
    if (paragraph.type === "character") {
      const cue = parseCue(text);
      if (cue) for (const token of tokens(cue.name)) vocabulary.add(token.toLowerCase());
    } else if (paragraph.type === "sceneHeading") {
      for (const token of tokens(text)) vocabulary.add(token.toLowerCase());
    } else {
      for (const token of tokens(text)) {
        if (token.length > 1 && token === token.toUpperCase()) capsCounts.set(token, (capsCounts.get(token) ?? 0) + 1);
      }
    }
  }
  for (const [word, count] of capsCounts) if (count > 1) vocabulary.add(word.toLowerCase());
  return vocabulary;
}

export interface WordSpan {
  word: string;
  from: number;
  to: number;
}

const SPELLED = new Set(["action", "dialogue", "parenthetical", "general", "shot", "lyrics"]);

/**
 * The words in a paragraph worth spell checking: skips short words, words with digits, capitals
 * (emphasis, sounds, names) and capitalized words in mid-sentence, which are usually proper nouns.
 */
export function spellingWords(paragraph: Paragraph): WordSpan[] {
  if (!SPELLED.has(paragraph.type)) return [];
  const text = checkedText(paragraph);
  const out: WordSpan[] = [];
  for (const match of text.matchAll(/(?<![\p{L}\p{N}'’_@/.-])\p{L}[\p{L}'’]*(?![\p{L}\p{N}_@/-])/gu)) {
    let word = match[0].replace(/['’]+$/, "");
    if (word.length < 3 || /\d/.test(word) || text.startsWith("://", match.index! + word.length)) continue;
    if (word === word.toUpperCase()) continue;
    if (/^\p{Lu}/u.test(word)) {
      const before = text.slice(0, match.index!).trimEnd();
      if (before && !/[.!?:]["')\]”’]*$/.test(before)) continue;
    }
    if (text[match.index! + word.length] === "." && /^\p{L}\.\p{L}/u.test(text.slice(match.index!))) continue;
    word = word.replace(/’/g, "'");
    out.push({ word, from: match.index!, to: match.index! + match[0].replace(/['’]+$/, "").length });
  }
  return out;
}

/**
 * Typing slips the macOS checker lets through (it guesses a language per word and accepts "teh" and "alot").
 * Lowercase typo to its fix. Short on purpose: only slips nobody writes deliberately.
 */
const COMMON_TYPOS: Record<string, string> = {
  teh: "the", hte: "the", adn: "and", taht: "that", thta: "that", wiht: "with", waht: "what", jsut: "just",
  thier: "their", wich: "which", whcih: "which", becuase: "because", beacuse: "because", alot: "a lot", stoped: "stopped", windwo: "window",
  recieve: "receive", recieved: "received", definately: "definitely", seperate: "separate", wierd: "weird", occured: "occurred",
  untill: "until", tommorow: "tomorrow", tomorow: "tomorrow", beleive: "believe", freind: "friend", cant: "can't",
  dont: "don't", doesnt: "doesn't", didnt: "didn't", wont: "won't", isnt: "isn't", wasnt: "wasn't", couldnt: "couldn't", wouldnt: "wouldn't",
};

/** The fix for a word that is a known typing slip, or undefined. */
export function commonTypo(word: string): string | undefined {
  const lower = word.toLowerCase();
  return Object.hasOwn(COMMON_TYPOS, lower) ? COMMON_TYPOS[lower] : undefined;
}

/** The paragraph's plain text, as the offsets in findings count it. */
export function paragraphText(paragraph: Paragraph): string {
  return plainText(paragraph.runs);
}
