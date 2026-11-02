// Fountain (fountain.io, spec 1.1) import and export.
//
// Fountain cannot hold everything FDX can: shots, general text and act markers export as action, and
// only bold, italic and underline survive. The writer's output always reads back to the same script,
// so a Fountain file can be opened, saved and reopened without drift.
//
// An omitted scene (Production > Omit Scene) is its OMITTED heading followed by the scene's text in a boneyard
// block that starts with the line "OMITTED SCENE". Fountain apps print neither the boneyard nor its text, and
// reading the file back puts the text inside the OMITTED heading again, so Restore Omitted Scene still works.
import { newId } from "./ids.ts";
import { fountainRuns, readInline, writeInline } from "./inline.ts";
import { type ElementType, type Paragraph, type Run, type Script, type TitleField, plainText } from "./model.ts";
import { isOmitted, omittedHeading, omittedParagraphs } from "./revisions.ts";

const HEADING = /^(?:INT\.?\/EXT|INT|EXT|EST|I\/E)[. ]/i;
const SCENE_NUMBER = /\s+#([A-Za-z0-9][A-Za-z0-9.\-]*)#$/;
const TITLE_KEY = /^([A-Za-z][^:\n]*):(.*)$/;
const PAGE_BREAK = /^={3,}$/;
const FORCE_CHARS = /^[!@~=#>.]|^\[\[|^\/\*/;

/** A line that is only spaces (two or more) is an intentional blank inside an element. */
const isHeldBlank = (line: string) => /^ {2,}$/.test(line);
const isBlank = (line: string | undefined) => line === undefined || (line.trim() === "" && !isHeldBlank(line));

function isCharacterCue(text: string): boolean {
  const name = text.replace(/\s*\^$/, "").replace(/\(.*$/, "").trim();
  return name.length > 0 && /\p{L}/u.test(name) && name === name.toUpperCase() && !FORCE_CHARS.test(text);
}

function isTransition(text: string): boolean {
  return text === text.toUpperCase() && /TO:$/.test(text) && /\p{L}/u.test(text);
}

interface Pending {
  paragraphs: Paragraph[];
  newPage: boolean;
}

function push(state: Pending, type: ElementType, runs: Run[], extra: Partial<Paragraph> = {}): Paragraph {
  const paragraph: Paragraph = { id: newId(), type, runs, ...extra };
  if (type === "sceneHeading") paragraph.sceneId = paragraph.id;
  if (state.newPage) paragraph.startsNewPage = true;
  state.newPage = false;
  state.paragraphs.push(paragraph);
  return paragraph;
}

function parseTitlePage(lines: string[]): { fields: TitleField[]; rest: number } {
  if (!TITLE_KEY.test(lines[0] ?? "") || HEADING.test(lines[0]!)) return { fields: [], rest: 0 };
  const fields: TitleField[] = [];
  let i = 0;
  for (; i < lines.length && !isBlank(lines[i]); i++) {
    const line = lines[i]!;
    const match = /^(?: {3,}|\t)/.test(line) ? null : TITLE_KEY.exec(line);
    if (match) {
      const value = match[2]!.trim();
      fields.push({ key: match[1]!.trim(), values: value ? [value] : [] });
    } else if (fields.length) {
      fields.at(-1)!.values.push(line.trim());
    } else {
      return { fields: [], rest: 0 };
    }
  }
  return { fields, rest: i };
}

export function parseFountain(source: string): Script {
  const lines = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const { fields, rest } = parseTitlePage(lines);
  const state: Pending = { paragraphs: [], newPage: false };
  let i = rest;
  const blankBefore = () => i === 0 || isBlank(lines[i - 1]);

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (isBlank(line) || (isHeldBlank(line) && blankBefore())) { i++; continue; }
    const forcedAction = trimmed.startsWith("!");

    if (!forcedAction && trimmed.startsWith("/*")) {
      const body: string[] = [];
      let text = trimmed.slice(2);
      let j = i;
      while (!text.includes("*/") && j + 1 < lines.length) { body.push(text); text = lines[++j]!; }
      if (text.includes("*/")) {
        body.push(text.slice(0, text.lastIndexOf("*/")));
        push(state, "note", [{ text: body.join("\n").replace(/^\n/, "").replace(/\n$/, "") }].filter((run) => run.text), { boneyard: true });
        i = j + 1;
        continue;
      }
    }
    if (!forcedAction && trimmed.startsWith("[[") && blankBefore()) {
      const body: string[] = [];
      let j = i;
      while (j < lines.length && !isBlank(lines[j])) body.push(lines[j++]!);
      const joined = body.join("\n").trim();
      if (joined.endsWith("]]") && joined.indexOf("]]") === joined.length - 2) {
        push(state, "note", [{ text: joined.slice(2, -2) }].filter((run) => run.text));
        i = j;
        continue;
      }
    }
    if (PAGE_BREAK.test(trimmed)) { state.newPage = true; i++; continue; }
    if (/^#/.test(trimmed)) {
      const [, hashes, text] = /^(#+)\s*(.*)$/.exec(trimmed)!;
      push(state, "section", text ? [{ text }] : [], { depth: hashes!.length });
      i++;
      continue;
    }
    if (/^=(?!==)/.test(trimmed)) {
      const text = trimmed.slice(1).trim();
      push(state, "synopsis", text ? [{ text }] : []);
      i++;
      continue;
    }
    if (trimmed.startsWith("~")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("~")) body.push(lines[i++]!.trim().slice(1).trim());
      push(state, "lyrics", readInline(body.join("\n")));
      continue;
    }
    if (blankBefore() && ((/^\.(?!\.)/.test(trimmed)) || HEADING.test(trimmed))) {
      let text = trimmed.startsWith(".") ? trimmed.slice(1).trim() : trimmed;
      const number = SCENE_NUMBER.exec(text);
      if (number) text = text.slice(0, number.index).trim();
      push(state, "sceneHeading", readInline(text), number ? { sceneNumber: number[1]! } : {});
      i++;
      continue;
    }
    if (trimmed.startsWith(">") && trimmed.endsWith("<") && trimmed.length > 1) {
      const body: string[] = [];
      while (i < lines.length && /^>.*<$/.test(lines[i]!.trim())) body.push(lines[i++]!.trim().slice(1, -1).trim());
      push(state, "action", readInline(body.join("\n")), { alignment: "Center" });
      continue;
    }
    if (trimmed.startsWith(">")) {
      push(state, "transition", readInline(trimmed.slice(1).trim()));
      i++;
      continue;
    }
    if (!forcedAction && blankBefore() && isTransition(trimmed) && isBlank(lines[i + 1])) {
      push(state, "transition", readInline(trimmed));
      i++;
      continue;
    }
    const forcedCharacter = trimmed.startsWith("@");
    if (!forcedAction && blankBefore() && (forcedCharacter || (isCharacterCue(trimmed) && !isBlank(lines[i + 1])))) {
      let cue = forcedCharacter ? trimmed.slice(1).trim() : trimmed;
      const dual = /\s*\^$/.test(cue);
      if (dual) cue = cue.replace(/\s*\^$/, "");
      const group: Paragraph[] = [push(state, "character", readInline(cue))];
      i++;
      let dialogue: string[] = [];
      const flush = () => {
        if (dialogue.length) group.push(push(state, "dialogue", readInline(dialogue.join("\n"))));
        dialogue = [];
      };
      while (i < lines.length && !isBlank(lines[i])) {
        const text = isHeldBlank(lines[i]!) ? "" : lines[i]!.trim();
        if (/^\(.*\)$/.test(text)) {
          flush();
          group.push(push(state, "parenthetical", readInline(text)));
        } else {
          dialogue.push(text);
        }
        i++;
      }
      flush();
      if (dual) markDual(state.paragraphs, group);
      continue;
    }

    // Action: every line up to the next blank line, indentation kept.
    const body: string[] = [];
    while (i < lines.length && !isBlank(lines[i])) {
      const raw = lines[i]!;
      body.push(isHeldBlank(raw) ? "" : raw);
      i++;
    }
    if (forcedAction) body[0] = body[0]!.replace(/^(\s*)!/, "$1");
    if (body.length === 1 && !body[0]!.trim()) body[0] = "";
    push(state, "action", readInline(body.join("\n")));
  }
  return { titlePage: fields, paragraphs: readOmitted(state.paragraphs) };
}

/** The first line of the boneyard block that holds an omitted scene's text. */
const OMITTED_BLOCK = "OMITTED SCENE";

/** Text for inside a boneyard block: a backslash is doubled and a closing star-slash written as *\/. */
const escapeBoneyard = (text: string) => text.replace(/\\/g, "\\\\").replace(/\*\//g, "*\\/");
const unescapeBoneyard = (text: string) => text.replace(/\\([\\/])/g, "$1");

/** A scene heading followed by an OMITTED SCENE boneyard block becomes an OMITTED heading that keeps the text. */
function readOmitted(paragraphs: Paragraph[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]!;
    const next = paragraphs[i + 1];
    const text = next?.type === "note" && next.boneyard ? plainText(next.runs) : "";
    if (paragraph.type !== "sceneHeading" || (text !== OMITTED_BLOCK && !text.startsWith(`${OMITTED_BLOCK}\n`))) {
      out.push(paragraph);
      continue;
    }
    const kept = parseFountain(unescapeBoneyard(text.slice(OMITTED_BLOCK.length + 1))).paragraphs;
    const { fdx } = omittedHeading(paragraph.sceneNumber ?? "", paragraph.sceneId ?? paragraph.id, kept);
    out.push({ ...paragraph, fdx });
    i++;
  }
  return out;
}

/** An omitted scene's text, as a boneyard block for after its OMITTED heading. Empty when it keeps none. */
function omittedBlock(heading: Paragraph): string[] {
  const kept = omittedParagraphs(heading);
  if (!kept.length) return [];
  const text = writeFountain({ titlePage: [], paragraphs: kept }).replace(/\n$/, "");
  return ["/*", OMITTED_BLOCK, ...escapeBoneyard(text).split("\n"), "*/"];
}

/** The right-hand speech (marked ^) pairs with the speech just before it. */
function markDual(paragraphs: Paragraph[], right: Paragraph[]): void {
  const start = paragraphs.length - right.length;
  let left = start - 1;
  while (left >= 0 && (paragraphs[left]!.type === "dialogue" || paragraphs[left]!.type === "parenthetical")) left--;
  if (left < 0 || paragraphs[left]!.type !== "character" || paragraphs[left]!.dual) return;
  const block = newId();
  for (let k = left; k < start; k++) paragraphs[k]!.dual = { block, side: 1 };
  for (let k = start; k < paragraphs.length; k++) paragraphs[k]!.dual = { block, side: 2 };
}

function trimRuns(runs: readonly Run[], mode: "both" | "end" = "both"): Run[] {
  const out = runs.map((run) => ({ ...run }));
  if (mode === "both") while (out[0] && !(out[0].text = out[0].text.replace(/^\s+/, ""))) out.shift();
  while (out.at(-1) && !(out.at(-1)!.text = out.at(-1)!.text.replace(/\s+$/, ""))) out.pop();
  return out;
}

/** Trim each line of a multi-line element, as the reader does for dialogue and lyrics. */
function trimLines(runs: readonly Run[]): Run[] {
  const lines: Run[][] = [[]];
  for (const run of runs) {
    run.text.split("\n").forEach((part, k) => {
      if (k > 0) lines.push([]);
      if (part) lines.at(-1)!.push({ ...run, text: part });
    });
  }
  return lines.flatMap((line, k) => [...(k > 0 ? [{ text: "\n" }] : []), ...trimRuns(line)]);
}

/** Written lines: inline markup applied, empty inner lines held open with two spaces. */
function bodyLines(runs: readonly Run[]): string[] {
  return writeInline(runs).split("\n").map((line) => (line.trim() === "" ? "  " : line));
}

const PRINTS_AS_ACTION: ReadonlySet<ElementType> = new Set(["action", "shot", "general", "castList", "newAct", "endOfAct"]);
const IN_SPEECH: ReadonlySet<ElementType> = new Set(["parenthetical", "dialogue"]);

/** Whether lines, written on their own, read back as one paragraph of this type. */
function readsAs(lines: readonly string[], type: ElementType): boolean {
  const reads = parseFountain(`\n${lines.join("\n")}\n`).paragraphs;
  return reads.length === 1 && reads[0]!.type === type && reads[0]!.alignment === undefined && !reads[0]!.startsNewPage;
}

function actionBlock(paragraph: Paragraph): string[] {
  if (paragraph.alignment?.toLowerCase() === "center") {
    return writeInline(trimLines(paragraph.runs)).split("\n").map((line) => `>${line.trim()}<`);
  }
  const runs = trimRuns(paragraph.runs, "end");
  if (!runs.length) return ["!"];
  const lines = bodyLines(runs);
  const first = lines[0]!;
  if (!readsAs(lines, "action") || /^\s*!/.test(first) || first.trim() === "") lines[0] = `!${first}`;
  return lines;
}

function speechBlock(paragraphs: readonly Paragraph[], start: number): { lines: string[]; next: number } {
  const cue = paragraphs[start]!;
  let end = start + 1;
  while (end < paragraphs.length && IN_SPEECH.has(paragraphs[end]!.type) && !paragraphs[end]!.startsNewPage) end++;
  let name = writeInline(trimRuns(cue.runs));
  const right = cue.dual?.side === 2 && paragraphs[start - 1]?.dual?.block === cue.dual.block;
  if (end === start + 1 || !isCharacterCue(name) || HEADING.test(name)) name = `@${name}`;
  const lines = [right ? `${name} ^` : name];
  for (let k = start + 1; k < end; k++) {
    const paragraph = paragraphs[k]!;
    // A parenthetical is one line; a dialogue paragraph may hold several.
    const written = paragraph.type === "parenthetical"
      ? bodyLines(trimRuns(paragraph.runs.map((run) => ({ ...run, text: run.text.replace(/\n/g, " ") }))))
      : bodyLines(trimLines(paragraph.runs));
    // Two dialogue paragraphs in a row merge in Fountain; that is the format's limit.
    lines.push(...written);
  }
  return { lines, next: end };
}

function block(paragraph: Paragraph): string[] {
  const text = writeInline(trimRuns(paragraph.runs));
  switch (paragraph.type) {
    case "sceneHeading": {
      const number = paragraph.sceneNumber && /^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(paragraph.sceneNumber) ? ` #${paragraph.sceneNumber}#` : "";
      const line = `${text.replace(/\n/g, " ")}${number}`;
      return [HEADING.test(line) && readsAs([line], "sceneHeading") ? line : `.${line}`];
    }
    case "transition": {
      const single = text.replace(/\n/g, " ");
      return [isTransition(single) && readsAs([single], "transition") ? single : `>${single}`];
    }
    case "lyrics":
      return writeInline(trimLines(paragraph.runs)).split("\n").map((line) => `~${line}`);
    case "section":
      return [`${"#".repeat(Math.max(1, paragraph.depth ?? 1))} ${plainText(paragraph.runs).replace(/\n/g, " ").trim()}`];
    case "synopsis":
      return [`= ${plainText(paragraph.runs).replace(/\n/g, " ").trim()}`];
    case "note":
      return paragraph.boneyard ? ["/*", plainText(paragraph.runs), "*/"] : [`[[${plainText(paragraph.runs)}]]`];
    default:
      return actionBlock(paragraph);
  }
}

function writeTitlePage(fields: readonly TitleField[]): string[] {
  return fields.flatMap(({ key, values }) =>
    values.length === 1 ? [`${key}: ${values[0]}`] : [`${key}:`, ...values.map((value) => `   ${value}`)]);
}

export function writeFountain(script: Script): string {
  const blocks: string[][] = [];
  const title = writeTitlePage(script.titlePage);
  if (title.length) blocks.push(title);
  const paragraphs = script.paragraphs;
  for (let i = 0; i < paragraphs.length; ) {
    const paragraph = paragraphs[i]!;
    if (paragraph.startsNewPage && blocks.length) blocks.push(["==="]);
    if (paragraph.type === "character") {
      const { lines, next } = speechBlock(paragraphs, i);
      blocks.push(lines);
      i = next;
      continue;
    }
    blocks.push(PRINTS_AS_ACTION.has(paragraph.type) || IN_SPEECH.has(paragraph.type) ? actionBlock(paragraph) : block(paragraph));
    if (isOmitted(paragraph)) {
      const kept = omittedBlock(paragraph);
      if (kept.length) blocks.push(kept);
    }
    i++;
  }
  const text = blocks.map((lines) => lines.join("\n")).join("\n\n");
  // Without a title page, a first line that looks like "Key: value" would be read as one.
  const first = text.split("\n")[0]!;
  const guard = !title.length && TITLE_KEY.test(first) && !HEADING.test(first) ? "\n" : "";
  return `${guard}${text}\n`;
}
