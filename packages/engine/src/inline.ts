// Fountain emphasis: *italic*, **bold**, ***both***, _underline_, with backslash escapes.
//
// A run of asterisks toggles a set of marks: one star is italic, two bold, three both. Because the
// costs 1, 2 and 3 are distinct, a run always means exactly one set of marks to switch, whichever of
// them are already open. A run may only close marks if it follows a non-space character, and only
// open marks if a non-space character follows it. Marks still open at the end of a line were never
// emphasis, so their delimiters are put back as literal text. Emphasis never spans a line break.
// Inline [[notes]] are kept as runs marked note, which never print.
import type { Run } from "./model.ts";

type Mark = "bold" | "italic" | "underline";
const STARS: Record<number, Mark[]> = { 1: ["italic"], 2: ["bold"], 3: ["bold", "italic"] };
const COST: Record<Mark, number> = { italic: 1, bold: 2, underline: 1 };

interface TextToken { text: string; marks: Set<Mark> }
interface DelimToken { char: "*" | "_"; literal: number }

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);

function readLine(line: string): Run[] {
  const tokens: (TextToken | DelimToken)[] = [];
  const open = new Map<Mark, number>();
  let buffer = "";
  const flush = () => {
    if (buffer) tokens.push({ text: buffer, marks: new Set(open.keys()) });
    buffer = "";
  };
  for (let i = 0; i < line.length; ) {
    const char = line[i]!;
    if (char === "\\" && /[*_\\[]/.test(line[i + 1] ?? "")) {
      buffer += line[i + 1];
      i += 2;
      continue;
    }
    if (char !== "*" && char !== "_") {
      buffer += char;
      i++;
      continue;
    }
    flush();
    let end = i;
    while (line[end] === char) end++;
    const token: DelimToken = { char, literal: end - i };
    const toggle = char === "*" ? STARS[end - i] : end - i === 1 ? ["underline" as Mark] : undefined;
    if (toggle) {
      const closing = toggle.filter((mark) => open.has(mark));
      const opening = toggle.filter((mark) => !open.has(mark));
      if ((!closing.length || !isSpace(line[i - 1])) && (!opening.length || !isSpace(line[end]))) {
        for (const mark of closing) open.delete(mark);
        for (const mark of opening) open.set(mark, tokens.length);
        token.literal = 0;
      }
    }
    tokens.push(token);
    i = end;
  }
  flush();

  // Unclosed marks: their opening delimiters become text again.
  for (const [mark, at] of open) {
    (tokens[at] as DelimToken).literal += COST[mark];
    for (let t = at + 1; t < tokens.length; t++) (tokens[t] as TextToken).marks?.delete(mark);
  }
  return tokens.map((token): Run => {
    if ("char" in token) return { text: token.char.repeat(token.literal) };
    const run: Run = { text: token.text };
    for (const mark of token.marks) run[mark] = true;
    return run;
  });
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out.at(-1);
    if (last && last.bold === run.bold && last.italic === run.italic && last.underline === run.underline) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

function readMarked(text: string): Run[] {
  const runs: Run[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) runs.push({ text: "\n" });
    runs.push(...readLine(line));
  });
  return mergeRuns(runs);
}

const MARKS: Mark[] = ["bold", "italic", "underline"];

/** Per-character marks, with marks moved off whitespace at the edges of each marked stretch. */
function charMarks(runs: readonly Run[]): { char: string; marks: Set<Mark> }[] {
  const chars: { char: string; marks: Set<Mark> }[] = [];
  for (const run of runs) {
    for (const char of run.text) chars.push({ char, marks: new Set(char === "\n" ? [] : MARKS.filter((mark) => run[mark])) });
  }
  for (const mark of MARKS) {
    for (let i = 0; i < chars.length; ) {
      if (!chars[i]!.marks.has(mark)) { i++; continue; }
      let j = i;
      while (j < chars.length && chars[j]!.marks.has(mark)) j++;
      let a = i, b = j;
      while (a < b && isSpace(chars[a]!.char)) chars[a++]!.marks.delete(mark);
      while (b > a && isSpace(chars[b - 1]!.char)) chars[--b]!.marks.delete(mark);
      i = j;
    }
  }
  return chars;
}

function markedRuns(runs: readonly Run[]): Run[] {
  return mergeRuns(charMarks(runs).map(({ char, marks }) => {
    const run: Run = { text: char };
    for (const mark of marks) run[mark] = true;
    return run;
  }));
}

function writeMarked(runs: readonly Run[]): string {
  let out = "";
  let open = new Set<Mark>();
  const switchTo = (next: Set<Mark>) => {
    const changed = MARKS.filter((mark) => open.has(mark) !== next.has(mark));
    const stars = changed.filter((mark) => mark !== "underline").reduce((sum, mark) => sum + COST[mark], 0);
    out += "*".repeat(stars) + (changed.includes("underline") ? "_" : "");
    open = next;
  };
  const chars = charMarks(runs);
  chars.forEach(({ char, marks }, i) => {
    switchTo(marks);
    // "[[" in script text would read back as a note, so its first bracket is escaped.
    out += /[*_\\]/.test(char) || (char === "[" && chars[i + 1]?.char === "[") ? `\\${char}` : char;
  });
  switchTo(new Set());
  return out;
}

const NOTE = /(?<!\\)\[\[([\s\S]*?)\]\]/g;
// Stands in for a note while emphasis is read, so a note inside bold text does not break the bold.
const NOTE_MARK = "\uE000";

export function readInline(text: string): Run[] {
  const notes: string[] = [];
  const marked = readMarked(text.replace(NOTE, (_, body: string) => (notes.push(body), NOTE_MARK)));
  const runs: Run[] = [];
  for (const run of marked) {
    run.text.split(NOTE_MARK).forEach((part, k) => {
      if (k > 0) {
        const note = notes.shift()!;
        if (note) runs.push({ text: note, note: true });
      }
      if (part) runs.push({ ...run, text: part });
    });
  }
  return runs;
}

/** Split runs into stretches of notes and of script text, in order. */
function segments(runs: readonly Run[]): { note: boolean; runs: Run[] }[] {
  const out: { note: boolean; runs: Run[] }[] = [];
  for (const run of runs) {
    const note = Boolean(run.note);
    if (out.at(-1)?.note === note && !note) out.at(-1)!.runs.push(run);
    else out.push({ note, runs: [run] });
  }
  return out;
}

/** What survives a Fountain round trip: notes, and bold, italic and underline never on edge whitespace. */
export function fountainRuns(runs: readonly Run[]): Run[] {
  return segments(runs).flatMap((part) => part.note ? part.runs.map((run) => ({ text: run.text, note: true as const })) : markedRuns(part.runs));
}

export function writeInline(runs: readonly Run[]): string {
  return segments(runs).map((part) => part.note ? `[[${part.runs[0]!.text}]]` : writeMarked(part.runs)).join("");
}
