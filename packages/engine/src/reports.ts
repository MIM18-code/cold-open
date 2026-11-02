// Reports over a script: characters, scenes, locations, statistics, the cast list, sides, character rename
// planning and CSV output. Everything here is pure and works on the plain Script. Pass one Pagination to
// several reports so a long script is laid out once.
import type { ScreenplayDoc } from "./doc.ts";
import {
  type Pagination, formatEighths, paginate, sceneEighths,
} from "./pagination.ts";
import {
  type ElementType, NON_PRINTING, type Paragraph, type Script, plainText, scenesOf,
} from "./model.ts";

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** A paragraph's text without inline [[notes]], which never print. */
function visibleText(paragraph: Paragraph): string {
  return paragraph.runs.filter((run) => !run.note).map((run) => run.text).join("");
}

/** "ROBERT (V.O.)", "Robert (CONT'D)" and "ROBERT ^" all name ROBERT. */
export function characterName(cue: string): string {
  return cue
    .replace(/\s*\([^)]*\)/g, " ")
    .replace(/\^/g, " ")
    .replace(/\s+CONT['’]D\.?\s*$/i, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .toUpperCase();
}

/** Where the cue's name ends, so (V.O.) and (CONT'D) stay put when the name is replaced. */
function cueNameRange(cue: string): [number, number] {
  const open = cue.indexOf("(");
  const contd = cue.search(/\s+CONT['’]D\b/i);
  const stops = [open, contd, cue.indexOf("^")].filter((i) => i >= 0);
  const end = stops.length ? Math.min(...stops) : cue.length;
  const head = cue.slice(0, end);
  return [head.length - head.trimStart().length, head.trimEnd().length];
}

export interface HeadingParts {
  setting: "INT" | "EXT" | "INT/EXT" | "";
  location: string;
  timeOfDay: string;
}

const SETTING = /^\s*(?:(INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|INT\/EXT\.?|I\/E\.?)|(INT\.?)|(EXT\.?|EST\.?))(?=[\s.-]|$)\s*[.\s-]*/i;

/** Split "INT. KITCHEN - NIGHT" into setting, location and time of day. Headings without INT/EXT keep the whole text as location. */
export function parseHeading(heading: string): HeadingParts {
  let text = heading.trim().replace(/^#?\d+[A-Z]?[.)]?\s+(?=\S)/, "");
  let setting: HeadingParts["setting"] = "";
  const found = text.match(SETTING);
  if (found) {
    setting = found[1] ? "INT/EXT" : found[2] ? "INT" : "EXT";
    text = text.slice(found[0].length);
  }
  text = text.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const split = text.match(/^(.*\S)\s+[-–—]{1,2}\s+([^-–—]+)$/);
  const location = (split ? split[1]! : text).replace(/^["']+|["']+$/g, "").trim().toUpperCase();
  const timeOfDay = split ? split[2]!.trim().toUpperCase() : "";
  return { setting, location, timeOfDay };
}

function sceneLabel(number: string | undefined, index: number): string {
  return number?.trim() ? number.trim() : String(index + 1);
}

function pageNumber(pagination: Pagination, paragraphId: string): string {
  const at = pagination.positions.get(paragraphId);
  return at ? pagination.pages[at.page]?.number ?? "" : "";
}

// ---------- characters ----------

export interface CharacterRow {
  /** Normalized name: no extensions, upper case. */
  name: string;
  /** False for a character who is named in action but never has a cue. */
  speaking: boolean;
  /** Scenes the character is in: a cue, or the name in action. */
  scenes: number;
  /** Scenes where the character speaks. */
  dialogueScenes: number;
  speeches: number;
  /** Words of dialogue and lyrics, not parentheticals. */
  words: number;
  /** Scene numbers as printed (or counted when unnumbered). Empty when the character never appears inside a scene. */
  firstScene: string;
  lastScene: string;
  firstPage: string;
  lastPage: string;
  /** Distinct pages the character speaks or is named on. */
  pages: number;
  /** The paragraph to reveal for this row: the first cue, or where the name first appears. */
  firstParagraphId: string;
  lastParagraphId: string;
}

interface Sighting {
  /** Index into the scene list, or -1 before the first scene heading. */
  scene: number;
  paragraphId: string;
}

/** Words that open or close an ALL CAPS stretch in action without belonging to a name. */
const NAME_FILLER = new Set(["A", "AN", "THE", "AND", "OR", "BUT", "AS", "AT", "IN", "ON", "OF", "TO", "FROM", "WITH", "BY", "THEN", "WHEN"]);
const AGE = /^\s*(?:\(\s*(?:\d|early|mid|late|teens|twenties|thirties|forties|fifties|sixties)|,\s*\d{1,3}s?\b)/i;

/** An ALL CAPS name of up to three words, which may open with a title ("DR. PARK") so the title is not cut off. */
const INTRODUCED = /(?:(?:DR|MR|MRS|MS|ST|SGT|LT|CPT|CAPT|COL|GEN|PROF|FR|REV)\. )?[A-Z][A-Z'’-]+(?: [A-Z][A-Z'’-]+){0,2}/g;

/** ALL CAPS names with an age or age range after them ("NELL (40s)"): the convention for introducing a character. */
function introducedNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(INTRODUCED)) {
    if (!AGE.test(text.slice(match.index + match[0].length))) continue;
    const words = match[0].split(" ");
    while (words.length && NAME_FILLER.has(words[0]!)) words.shift();
    while (words.length && NAME_FILLER.has(words.at(-1)!)) words.pop();
    const name = words.join(" ");
    if (name.replace(/[^A-Z]/g, "").length >= 2) names.push(name);
  }
  return names;
}

export interface Mention {
  from: number;
  to: number;
  /** "caps" for ROBERT, "proper" for Robert. Lower case matches are not mentions of a character. */
  style: "caps" | "proper";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-aware mentions of a name in text. */
export function findMentions(text: string, name: string): Mention[] {
  if (!name.trim() || !text.toLowerCase().includes(name.toLowerCase())) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(name).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_-])`, "giu");
  const found: Mention[] = [];
  for (const match of text.matchAll(pattern)) {
    const word = match[0];
    const caps = word === word.toUpperCase() && word !== word.toLowerCase();
    const first = word[0]!;
    if (caps) found.push({ from: match.index, to: match.index + word.length, style: "caps" });
    else if (first !== first.toLowerCase()) found.push({ from: match.index, to: match.index + word.length, style: "proper" });
  }
  return found;
}

/** Paragraph types where a character can be named without speaking. */
const MENTION_TYPES: ReadonlySet<ElementType> = new Set(["action", "general", "shot"]);

/**
 * One row per character, in order of first appearance: every speaker, then anyone introduced in ALL CAPS
 * in action who never speaks. Pages come from the pagination, which is computed when not given.
 */
export function characterReport(script: Script, pagination: Pagination = paginate(script)): CharacterRow[] {
  const scenes = scenesOf(script.paragraphs);
  const sceneOfParagraph = new Map<string, number>();
  scenes.forEach((scene, index) => scene.paragraphIds.forEach((id) => sceneOfParagraph.set(id, index)));

  const speakers = new Map<string, { sightings: Sighting[]; speeches: number; words: number }>();
  const speaker = (name: string) => {
    let entry = speakers.get(name);
    if (!entry) speakers.set(name, (entry = { sightings: [], speeches: 0, words: 0 }));
    return entry;
  };
  const { paragraphs } = script;
  for (let i = 0; i < paragraphs.length; i++) {
    const cue = paragraphs[i]!;
    if (cue.type !== "character") continue;
    const name = characterName(plainText(cue.runs));
    if (!name) continue;
    const entry = speaker(name);
    entry.speeches++;
    entry.sightings.push({ scene: sceneOfParagraph.get(cue.id) ?? -1, paragraphId: cue.id });
    for (let j = i + 1; j < paragraphs.length; j++) {
      const line = paragraphs[j]!;
      if (line.type === "dialogue" || line.type === "lyrics") entry.words += countWords(visibleText(line));
      else if (line.type !== "parenthetical" && !NON_PRINTING.has(line.type)) break;
    }
  }

  // Names that appear in action: the speakers, plus anyone introduced in ALL CAPS with an age.
  const position = new Map(paragraphs.map((p, index) => [p.id, index]));
  const introduced = new Map<string, string>();
  for (const paragraph of paragraphs) {
    if (paragraph.type !== "action") continue;
    for (const name of introducedNames(visibleText(paragraph))) if (!speakers.has(name) && !introduced.has(name)) introduced.set(name, paragraph.id);
  }
  const named = new Map<string, Sighting[]>();
  for (const name of [...speakers.keys(), ...introduced.keys()]) named.set(name, []);
  for (const paragraph of paragraphs) {
    if (!MENTION_TYPES.has(paragraph.type)) continue;
    const text = visibleText(paragraph);
    const lower = text.toLowerCase();
    for (const [name, sightings] of named) {
      if (!lower.includes(name.toLowerCase())) continue;
      // An introduced character exists from the line that introduces them.
      const introducedAt = introduced.get(name);
      if (introducedAt && position.get(paragraph.id)! < position.get(introducedAt)!) continue;
      if (findMentions(text, name).length) sightings.push({ scene: sceneOfParagraph.get(paragraph.id) ?? -1, paragraphId: paragraph.id });
    }
  }

  const rows: CharacterRow[] = [];
  for (const [name, sightings] of named) {
    const spoken = speakers.get(name);
    const all = [...(spoken?.sightings ?? []), ...sightings].sort((a, b) => position.get(a.paragraphId)! - position.get(b.paragraphId)!);
    if (!all.length) continue;
    const first = all[0]!, last = all.at(-1)!;
    const pages = new Set(all.map((s) => pageNumber(pagination, s.paragraphId)).filter(Boolean));
    rows.push({
      name,
      speaking: !!spoken,
      scenes: new Set(all.filter((s) => s.scene >= 0).map((s) => s.scene)).size,
      dialogueScenes: new Set((spoken?.sightings ?? []).filter((s) => s.scene >= 0).map((s) => s.scene)).size,
      speeches: spoken?.speeches ?? 0,
      words: spoken?.words ?? 0,
      firstScene: first.scene >= 0 ? sceneLabel(scenes[first.scene]!.number, first.scene) : "",
      lastScene: last.scene >= 0 ? sceneLabel(scenes[last.scene]!.number, last.scene) : "",
      firstPage: pageNumber(pagination, first.paragraphId),
      lastPage: pageNumber(pagination, last.paragraphId),
      pages: pages.size,
      firstParagraphId: first.paragraphId,
      lastParagraphId: last.paragraphId,
    });
  }
  return rows.sort((a, b) => position.get(a.firstParagraphId)! - position.get(b.firstParagraphId)!);
}

export interface CastMember {
  name: string;
  speeches: number;
  /** Scene number where the character first speaks. */
  firstScene: string;
}

/** Speaking characters in order of first speech, as a cast page lists them. */
export function castList(script: Script): CastMember[] {
  const members = new Map<string, CastMember>();
  const scenes = scenesOf(script.paragraphs);
  let scene = -1;
  for (const paragraph of script.paragraphs) {
    if (paragraph.type === "sceneHeading") scene++;
    if (paragraph.type !== "character") continue;
    const name = characterName(plainText(paragraph.runs));
    if (!name) continue;
    const member = members.get(name);
    if (member) member.speeches++;
    else members.set(name, { name, speeches: 1, firstScene: scene >= 0 ? sceneLabel(scenes[scene]!.number, scene) : "" });
  }
  return [...members.values()];
}

// ---------- scenes ----------

export interface SceneRow {
  sceneId: string;
  headingId: string;
  index: number;
  /** Printed scene number, or the scene's position when the script is unnumbered. */
  number: string;
  heading: string;
  setting: HeadingParts["setting"];
  location: string;
  timeOfDay: string;
  /** Printed page number where the scene starts. */
  page: string;
  /** Length in eighths of a page. */
  eighths: number;
  /** "1 3/8" style. */
  length: string;
  /** Speaking characters in order of first cue. */
  characters: string[];
  /** Words in the scene, not counting the heading. */
  words: number;
}

export function sceneReport(script: Script, pagination: Pagination = paginate(script)): SceneRow[] {
  const eighths = sceneEighths(script, pagination);
  const byId = new Map(script.paragraphs.map((p) => [p.id, p]));
  return scenesOf(script.paragraphs).map((scene, index) => {
    const characters: string[] = [];
    let words = 0;
    for (const id of scene.paragraphIds.slice(1)) {
      const paragraph = byId.get(id)!;
      if (NON_PRINTING.has(paragraph.type)) continue;
      words += countWords(visibleText(paragraph));
      if (paragraph.type === "character") {
        const name = characterName(plainText(paragraph.runs));
        if (name && !characters.includes(name)) characters.push(name);
      }
    }
    const length = eighths.get(scene.sceneId) ?? 0;
    return {
      sceneId: scene.sceneId,
      headingId: scene.headingId,
      index,
      number: sceneLabel(scene.number, index),
      heading: scene.heading,
      ...parseHeading(scene.heading),
      page: pageNumber(pagination, scene.headingId),
      eighths: length,
      length: formatEighths(length),
      characters,
      words,
    };
  });
}

// ---------- locations ----------

export interface LocationRow {
  location: string;
  setting: HeadingParts["setting"];
  scenes: number;
  eighths: number;
  length: string;
  /** Scene numbers, in script order. */
  sceneNumbers: string[];
  /** The first scene heading here, for jumping to it. */
  firstHeadingId: string;
}

/** Scenes grouped by location and INT/EXT, in order of first scene. Pass the scene report when you have it. */
export function locationReport(script: Script, pagination?: Pagination, scenes: readonly SceneRow[] = sceneReport(script, pagination)): LocationRow[] {
  const rows = new Map<string, LocationRow>();
  for (const scene of scenes) {
    const key = `${scene.setting}|${scene.location}`;
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { location: scene.location, setting: scene.setting, scenes: 0, eighths: 0, length: "", sceneNumbers: [], firstHeadingId: scene.headingId }));
    row.scenes++;
    row.eighths += scene.eighths;
    row.sceneNumbers.push(scene.number);
  }
  for (const row of rows.values()) row.length = formatEighths(row.eighths);
  return [...rows.values()];
}

// ---------- statistics ----------

export interface ScriptStatistics {
  /** Printed pages. */
  pages: number;
  scenes: number;
  /** Words in every printing element. */
  words: number;
  dialogueWords: number;
  actionWords: number;
  /** Shares of dialogue and action words together, 0 to 1. */
  dialogueShare: number;
  actionShare: number;
  speakingCharacters: number;
  locations: number;
  /** Total scene length in eighths of a page. */
  eighths: number;
  averageSceneEighths: number;
  longestScene: { number: string; heading: string; eighths: number } | null;
  elements: Partial<Record<ElementType, number>>;
}

/** Counts for the whole script. Pass the scene report when you have it, so it is not worked out again. */
export function scriptStatistics(script: Script, pagination: Pagination = paginate(script), scenes: readonly SceneRow[] = sceneReport(script, pagination)): ScriptStatistics {
  const elements: Partial<Record<ElementType, number>> = {};
  let words = 0, dialogueWords = 0, actionWords = 0;
  for (const paragraph of script.paragraphs) {
    if (NON_PRINTING.has(paragraph.type)) continue;
    elements[paragraph.type] = (elements[paragraph.type] ?? 0) + 1;
    const count = countWords(visibleText(paragraph));
    words += count;
    if (paragraph.type === "dialogue" || paragraph.type === "lyrics") dialogueWords += count;
    else if (paragraph.type === "action") actionWords += count;
  }
  const eighths = scenes.reduce((sum, scene) => sum + scene.eighths, 0);
  const longest = scenes.reduce<SceneRow | null>((best, scene) => (!best || scene.eighths > best.eighths ? scene : best), null);
  const spoken = dialogueWords + actionWords;
  return {
    pages: pagination.pages.length,
    scenes: scenes.length,
    words,
    dialogueWords,
    actionWords,
    dialogueShare: spoken ? dialogueWords / spoken : 0,
    actionShare: spoken ? actionWords / spoken : 0,
    speakingCharacters: castList(script).length,
    locations: new Set(scenes.map((scene) => scene.location)).size,
    eighths,
    averageSceneEighths: scenes.length ? eighths / scenes.length : 0,
    longestScene: longest ? { number: longest.number, heading: longest.heading, eighths: longest.eighths } : null,
    elements,
  };
}

// ---------- sides ----------

export interface SidesOptions {
  /** Give unnumbered scenes their number in the full script, so sides match the script. Default true. */
  keepNumbers?: boolean;
}

/** A script with only these scenes, in script order, and the original title page. */
export function sidesScript(script: Script, sceneIds: Iterable<string>, options: SidesOptions = {}): Script {
  const wanted = new Set(sceneIds);
  const keepNumbers = options.keepNumbers ?? true;
  const byId = new Map(script.paragraphs.map((p) => [p.id, p]));
  const paragraphs: Paragraph[] = [];
  scenesOf(script.paragraphs).forEach((scene, index) => {
    if (!wanted.has(scene.sceneId)) return;
    for (const id of scene.paragraphIds) paragraphs.push(structuredClone(byId.get(id)!));
    const heading = paragraphs.at(-scene.paragraphIds.length)!;
    if (keepNumbers && heading.sceneNumber === undefined) heading.sceneNumber = String(index + 1);
  });
  return { titlePage: structuredClone(script.titlePage), paragraphs, ...(script.template ? { template: script.template } : {}), ...(script.fdx ? { fdx: structuredClone(script.fdx) } : {}) };
}

// ---------- rename ----------

export interface TextEdit {
  paragraphId: string;
  /** Character range in the paragraph's plain text. */
  from: number;
  to: number;
  text: string;
  kind: "cue" | "mention";
}

export interface RenamePlan {
  /** In script order; within a paragraph, last edit first, so applying them in order keeps offsets valid. */
  edits: TextEdit[];
  cues: number;
  mentions: number;
  paragraphs: number;
  /** The new name as it goes into cues and caps text, and into normal text. */
  upper: string;
  proper: string;
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_all, lead: string, letter: string) => lead + letter.toUpperCase());
}

/** Types whose text can mention a character. Scene headings and transitions are left alone. */
const RENAME_TYPES: ReadonlySet<ElementType> = new Set(["action", "dialogue", "parenthetical", "general", "shot", "lyrics", "castList"]);

/**
 * What renaming a character would change: every cue (extensions like (V.O.) stay), and whole-word mentions in
 * action and dialogue, ROBERT as caps and Robert as normal text. Lower case words are left alone.
 */
export function planRename(script: Script, from: string, to: string): RenamePlan {
  const oldKey = characterName(from);
  const name = to.trim().replace(/\s+/g, " ");
  const upper = name.toUpperCase();
  const proper = name === upper || name === name.toLowerCase() ? titleCase(name) : name;
  const plan: RenamePlan = { edits: [], cues: 0, mentions: 0, paragraphs: 0, upper, proper };
  if (!oldKey || !name || upper === oldKey) return plan;
  for (const paragraph of script.paragraphs) {
    const text = plainText(paragraph.runs);
    const edits: TextEdit[] = [];
    if (paragraph.type === "character") {
      if (characterName(text) === oldKey) {
        const [start, end] = cueNameRange(text);
        edits.push({ paragraphId: paragraph.id, from: start, to: end, text: upper, kind: "cue" });
      }
    } else if (RENAME_TYPES.has(paragraph.type)) {
      for (const mention of findMentions(text, oldKey)) {
        edits.push({ paragraphId: paragraph.id, from: mention.from, to: mention.to, text: mention.style === "caps" ? upper : proper, kind: "mention" });
      }
    }
    if (!edits.length) continue;
    plan.paragraphs++;
    for (const edit of edits) plan[edit.kind === "cue" ? "cues" : "mentions"]++;
    plan.edits.push(...edits.sort((a, b) => b.from - a.from));
  }
  return plan;
}

type DeltaOp = { insert?: unknown; attributes?: Record<string, unknown> };

/**
 * Apply a rename plan to the document as one Y.Text delta, so the cost is one pass over the script instead of one
 * per edit. The new text takes the formatting of the old range's last character, as typing there would. Call inside
 * session.edit() so it is one undo step.
 */
export function applyTextEdits(doc: ScreenplayDoc, edits: readonly TextEdit[]): void {
  const ops = doc.body.toDelta() as DeltaOp[];
  const starts = new Map<string, number>();
  let offset = 0;
  for (const op of ops) {
    if (typeof op.insert !== "string") {
      offset += 1;
      continue;
    }
    if (op.attributes?.soft) {
      offset += op.insert.length;
      continue;
    }
    op.insert.split("\n").forEach((part, k) => {
      if (k > 0) {
        if (typeof op.attributes?.id === "string") starts.set(op.attributes.id, offset + 1);
        offset += 1;
      }
      offset += part.length;
    });
  }
  const placed = edits.map((edit) => {
    const start = starts.get(edit.paragraphId);
    if (start === undefined) throw new RangeError(`No paragraph with ID ${edit.paragraphId}.`);
    return { from: start + edit.from, to: start + edit.to, text: edit.text };
  }).sort((a, b) => a.from - b.from);

  const delta: { retain?: number; insert?: string; delete?: number; attributes?: Record<string, unknown> }[] = [];
  let opIndex = 0, opStart = 0, cursor = 0;
  for (const edit of placed) {
    if (edit.from < cursor) continue; // overlapping edits cannot come from one plan
    // The run formatting of the character just before the end of the old range.
    const last = edit.to - 1;
    while (opIndex < ops.length - 1 && opStart + (typeof ops[opIndex]!.insert === "string" ? (ops[opIndex]!.insert as string).length : 1) <= last) {
      opStart += typeof ops[opIndex]!.insert === "string" ? (ops[opIndex]!.insert as string).length : 1;
      opIndex++;
    }
    if (edit.from > cursor) delta.push({ retain: edit.from - cursor });
    delta.push({ insert: edit.text, attributes: { ...ops[opIndex]?.attributes } });
    delta.push({ delete: edit.to - edit.from });
    cursor = edit.to;
  }
  if (delta.length) doc.body.applyDelta(delta);
}

// ---------- CSV ----------

function csvCell(value: string | number): string {
  // A script's text can start with = + - or @, which spreadsheets run as formulas. A leading quote keeps it text.
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Comma-separated values with a byte order mark, so Excel and Numbers read accented names correctly. */
export function toCsv(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
