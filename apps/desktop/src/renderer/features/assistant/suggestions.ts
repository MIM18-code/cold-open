// Edits the assistant proposes. The model writes each one as a ```suggestion block holding JSON; the panel shows it
// with an Apply button, and applying finds the exact text in the script first. A change that can't be placed
// exactly is never guessed at.
import { NON_PRINTING, type Script, scenesOf } from "@screenplay/engine";

export interface Suggestion {
  find: string;
  replace: string;
  why?: string;
  scene?: string;
}

export type Piece = { type: "text"; text: string } | { type: "suggestion"; suggestion: Suggestion };

const BLOCK = /```suggestion[^\n]*\n([\s\S]*?)```/g;

function parseSuggestion(json: string): Suggestion | null {
  try {
    const value = JSON.parse(json.trim()) as Record<string, unknown>;
    if (typeof value.find !== "string" || !value.find || typeof value.replace !== "string" || value.find === value.replace) return null;
    return {
      find: value.find, replace: value.replace,
      ...(typeof value.why === "string" && value.why ? { why: value.why } : {}),
      ...(typeof value.scene === "string" || typeof value.scene === "number" ? { scene: String(value.scene) } : {}),
    };
  } catch {
    return null;
  }
}

/** Split an answer into prose and suggestion blocks. A block that does not parse stays as text. */
export function splitAnswer(answer: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of answer.matchAll(BLOCK)) {
    const suggestion = parseSuggestion(match[1]!);
    if (!suggestion) continue;
    const before = answer.slice(last, match.index!).trim();
    if (before) pieces.push({ type: "text", text: before });
    pieces.push({ type: "suggestion", suggestion });
    last = match.index! + match[0].length;
  }
  const rest = answer.slice(last).trim();
  if (rest) pieces.push({ type: "text", text: rest });
  return pieces;
}

export type Located = { paragraphId: string; from: number; to: number } | { error: string };

/**
 * The paragraph's text as the writer sees it (inline notes left out), and a map from each visible offset to the
 * offset in the paragraph's runs, so a match in visible text is applied to the right characters.
 */
function visible(runs: Script["paragraphs"][number]["runs"]): { text: string; source: number[] } {
  let text = "", at = 0;
  const source: number[] = [];
  for (const run of runs) {
    if (!run.note) for (let i = 0; i < run.text.length; i++) { text += run.text[i]; source.push(at + i); }
    at += run.text.length;
  }
  source.push(at);
  return { text, source };
}

/**
 * Find the suggestion's text in the script. It must sit inside one paragraph, be unambiguous, and match what the
 * writer sees: text inside a private note never matches, and a passage with a note inside it is left to the writer.
 */
export function locate(script: Script, suggestion: Suggestion): Located {
  const scenes = scenesOf(script.paragraphs);
  const sceneOf = new Map<string, string>();
  scenes.forEach((scene, index) => {
    const label = String(scene.number || index + 1);
    for (const id of scene.paragraphIds) sceneOf.set(id, label);
  });
  const hits: { paragraphId: string; from: number; to: number; scene: string | undefined }[] = [];
  for (const paragraph of script.paragraphs) {
    // Notes, synopses and sections are the writer's own and never printed: never an edit target.
    if (NON_PRINTING.has(paragraph.type)) continue;
    const { text, source } = visible(paragraph.runs);
    for (let at = text.indexOf(suggestion.find); at >= 0; at = text.indexOf(suggestion.find, at + 1)) {
      const end = at + suggestion.find.length;
      hits.push({ paragraphId: paragraph.id, from: source[at]!, to: source[end - 1]! + 1, scene: sceneOf.get(paragraph.id) });
    }
  }
  if (!hits.length) return { error: "That text is not in the script, so it can't be applied." };
  // A scene the suggestion names is binding: the same words elsewhere are a different line, never a fallback.
  const pool = suggestion.scene ? hits.filter((hit) => hit.scene === suggestion.scene) : hits;
  if (!pool.length) return { error: `That text is no longer in scene ${suggestion.scene}, so it can't be applied.` };
  if (pool.length > 1) return { error: `That text appears ${pool.length} times. Select the one you mean and edit it by hand.` };
  const hit = pool[0]!;
  if (hit.to - hit.from !== suggestion.find.length) return { error: "That passage has a private note inside it. Edit it by hand." };
  return { paragraphId: hit.paragraphId, from: hit.from, to: hit.to };
}
