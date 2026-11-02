// "Check with AI": split the script into scene-sized chunks, ask the provider for typo and continuity findings as
// JSON anchored by exact quotes, and keep only findings whose quote appears verbatim in the paragraph. Nothing the
// model says is applied; each kept finding goes through the same accept or ignore list as the engine's.
import { type Finding, type Paragraph, checkedText, findingId, parseCue } from "@screenplay/engine";

export interface ChunkLine {
  /** Number the model sees for this paragraph, from 1. */
  n: number;
  paragraph: Paragraph;
  text: string;
}

export interface Chunk {
  lines: ChunkLine[];
  text: string;
}

const SKIPPED = new Set(["section", "synopsis", "note"]);

function lineText(paragraph: Paragraph): string {
  return checkedText(paragraph).replace(/\u0001/g, " ").replace(/\n/g, " ");
}

/** Group paragraphs into chunks that end at scene boundaries where possible and never exceed `maxChars` unless one scene does. */
export function chunkParagraphs(paragraphs: readonly Paragraph[], maxChars: number): Chunk[] {
  const scenes: Paragraph[][] = [];
  for (const paragraph of paragraphs) {
    if (SKIPPED.has(paragraph.type)) continue;
    if (paragraph.type === "sceneHeading" || !scenes.length) scenes.push([]);
    scenes.at(-1)!.push(paragraph);
  }
  const chunks: Chunk[] = [];
  let current: Paragraph[] = [];
  let size = 0;
  const flush = () => {
    if (current.length) chunks.push(makeChunk(current));
    current = [];
    size = 0;
  };
  for (const scene of scenes) {
    const sceneSize = scene.reduce((n, p) => n + lineText(p).length + 16, 0);
    if (current.length && size + sceneSize > maxChars) flush();
    if (sceneSize > maxChars) {
      // One long scene: split it between paragraphs.
      for (const paragraph of scene) {
        const length = lineText(paragraph).length + 16;
        if (current.length && size + length > maxChars) flush();
        current.push(paragraph);
        size += length;
      }
      continue;
    }
    current.push(...scene);
    size += sceneSize;
  }
  flush();
  return chunks;
}

function makeChunk(paragraphs: Paragraph[]): Chunk {
  const lines = paragraphs.map((paragraph, index) => ({ n: index + 1, paragraph, text: lineText(paragraph) }));
  return { lines, text: lines.map((line) => `P${line.n} [${line.paragraph.type}] ${line.text}`).join("\n") };
}

export const AI_CHECK_SYSTEM = [
  "You proofread screenplay excerpts. Report only clear problems:",
  "- typos and misspellings, including names spelled two different ways",
  "- repeated or missing words",
  "- continuity slips visible inside the excerpt, such as a prop, age or time of day that contradicts an earlier line",
  "Do not comment on story, style, pacing or the quality of dialogue. Do not suggest rewrites. Stay quiet and factual.",
  "Each line of the excerpt starts with its paragraph number and element type, like: P3 [dialogue] text.",
  'Answer with one JSON object and nothing else: {"findings":[{"paragraph":3,"quote":"exact words copied from that paragraph","kind":"typo","message":"what is wrong","replacement":"the corrected quote, only for typos"}]}.',
  'kind is "typo" or "continuity". Copy quote exactly as written, letter for letter, and keep it short. If nothing is wrong, answer {"findings":[]}.',
].join("\n");

export function checkPrompt(chunk: Chunk, names: readonly string[]): string {
  const known = names.length ? `Character names used in this script: ${names.join(", ")}.\n\n` : "";
  return `${known}Excerpt:\n${chunk.text}`;
}

/** The distinct character names in a script, for the prompt. */
export function characterNames(paragraphs: readonly Paragraph[]): string[] {
  const names = new Set<string>();
  for (const paragraph of paragraphs) {
    if (paragraph.type !== "character") continue;
    const cue = parseCue(checkedText(paragraph));
    if (cue) names.add(cue.name);
  }
  return [...names].slice(0, 40);
}

function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1), text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

/** Whether the answer holds JSON at all. An unreadable answer is an error, not "nothing found". */
export function isReadable(raw: string): boolean {
  return extractJson(raw) !== null;
}

/** Findings from the model's answer, with every one whose quote is not found verbatim dropped. */
export function parseAiFindings(raw: string, chunk: Chunk): Finding[] {
  const parsed = extractJson(raw) as { findings?: unknown } | unknown[] | null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { findings?: unknown } | null)?.findings) ? (parsed as { findings: unknown[] }).findings : [];
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { paragraph, quote, kind, message, replacement } = item as Record<string, unknown>;
    if (typeof quote !== "string" || !quote.trim() || quote.length > 240 || typeof message !== "string" || !message.trim()) continue;
    const preferred = typeof paragraph === "number" ? chunk.lines.find((line) => line.n === paragraph) : undefined;
    const home = [preferred, ...chunk.lines].find((line) => line && line.text.includes(quote));
    if (!home) continue;
    const from = home.text.indexOf(quote);
    const rule = kind === "continuity" ? "ai.continuity" : "ai.typo";
    const id = findingId(rule, home.paragraph.id, `${quote}\u0000${message}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id, paragraphId: home.paragraph.id, from, to: from + quote.length, kind: "ai", rule, message: message.trim().slice(0, 300),
      ...(kind !== "continuity" && typeof replacement === "string" && replacement !== quote && replacement.length <= 480 ? { replacement } : {}),
    });
  }
  return out;
}

/** The paragraphs of the scene that holds `paragraphId` (the first scene when it is unknown). */
export function sceneParagraphs(paragraphs: readonly Paragraph[], paragraphId: string | null): Paragraph[] {
  const at = paragraphId ? paragraphs.findIndex((paragraph) => paragraph.id === paragraphId) : -1;
  let start = 0;
  for (let i = Math.max(at, 0); i >= 0; i--) {
    if (paragraphs[i]!.type === "sceneHeading") {
      start = i;
      break;
    }
  }
  let end = paragraphs.length;
  for (let i = start + 1; i < paragraphs.length; i++) {
    if (paragraphs[i]!.type === "sceneHeading") {
      end = i;
      break;
    }
  }
  return paragraphs.slice(start, end);
}
