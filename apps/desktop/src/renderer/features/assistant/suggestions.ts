// Edits the assistant proposes. The model writes each one as a ```suggestion block holding JSON; the panel shows it
// with an Apply button, and applying finds the exact text in the script first. A change that can't be placed
// exactly is never guessed at.
import { NON_PRINTING, type Script, scenesOf, speechesOf, type XmlNode } from "@screenplay/engine";

export interface Suggestion {
  find: string;
  replace: string;
  why?: string;
  scene?: string;
  cut?: "speech" | "paragraph";
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
      ...(value.cut === "speech" || value.cut === "paragraph" ? { cut: value.cut } : {}),
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
// Final Draft writes curly quotes and dashes; models type straight ones. Each maps to one character, so offsets hold.
const TYPOGRAPHIC: Record<string, string> = { "\u2018": "'", "\u2019": "'", "\u02bc": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "-", "\u00a0": " " };
export const plainMarks = (text: string): string => text.replace(/[\u2018\u2019\u02bc\u201c\u201d\u2013\u2014\u00a0]/g, (mark) => TYPOGRAPHIC[mark]!);

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
  return locatePassage(script, suggestion, false);
}

function locatePassage(script: Script, suggestion: Suggestion, cutting: boolean): Located {
  if (!suggestion.find.trim()) return { error: "Find text is empty." };
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
    const { text: shown, source } = visible(paragraph.runs);
    const text = plainMarks(shown), find = plainMarks(suggestion.find);
    for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) {
      const end = at + suggestion.find.length;
      hits.push({ paragraphId: paragraph.id, from: source[at]!, to: source[end - 1]! + 1, scene: sceneOf.get(paragraph.id) });
    }
  }
  if (!hits.length) return { error: "That text is not in the script, so it can't be applied." };
  // A scene the suggestion names is binding: the same words elsewhere are a different line, never a fallback.
  const pool = suggestion.scene ? hits.filter((hit) => hit.scene === suggestion.scene) : hits;
  if (!pool.length) return { error: `That text is no longer in scene ${suggestion.scene}, so it can't be applied.` };
  if (cutting && pool.some((hit) => {
    const paragraph = script.paragraphs.find((p) => p.id === hit.paragraphId)!;
    return paragraph.type === "character" && plainMarks(visible(paragraph.runs).text).trim() === plainMarks(suggestion.find).trim();
  })) return { error: "Quote the dialogue line instead of the character cue. Cues repeat and are ambiguous." };
  if (pool.length > 1) return { error: `That text appears ${pool.length} times. Select the one you mean and edit it by hand.` };
  const hit = pool[0]!;
  if (!cutting && hit.to - hit.from !== suggestion.find.length) return { error: "That passage has a private note inside it. Edit it by hand." };
  return { paragraphId: hit.paragraphId, from: hit.from, to: hit.to };
}

const holdsScriptNote = (children: readonly (XmlNode | string)[] | undefined): boolean =>
  !!children?.some((node) => typeof node !== "string" && (node.name === "ScriptNote" || holdsScriptNote(node.children)));
/** A Final Draft ScriptNote carried on the paragraph itself. */
const hasScriptNote = (paragraph: Script["paragraphs"][number]): boolean => holdsScriptNote(paragraph.fdx?.before) || holdsScriptNote(paragraph.fdx?.after);

export type LocatedCut = { paragraphIds: string[]; cut: "speech" | "paragraph" } | { error: string };

/** Re-derive the cut from the live text and speech structure; proposals never retain paragraph IDs. */
export function locateCut(script: Script, suggestion: Suggestion): LocatedCut {
  const found = locatePassage(script, suggestion, true);
  if ("error" in found) return found;
  const target = script.paragraphs.find((p) => p.id === found.paragraphId)!;
  if (suggestion.replace.trim() || plainMarks(visible(target.runs).text).trim() !== plainMarks(suggestion.find).trim()) {
    return { error: "That text is no longer a whole paragraph, so the cut can't be applied." };
  }
  if (target.type === "sceneHeading") return { error: "Scene headings can't be cut." };
  const speech = speechesOf(script.paragraphs).find((speech) => speech.paragraphs.some((p) => p.id === target.id));
  if (target.dual || speech?.paragraphs.some((p) => p.dual)) return { error: "Edit dual dialogue by hand." };
  let removed = [target];
  let cut: "speech" | "paragraph" = "paragraph";
  if (speech && (target.type === "dialogue" || target.type === "lyrics")) {
    // A dialogue paragraph the writer emptied doesn't keep the speech alive.
    const dialogue = speech.paragraphs.filter((p) => (p.type === "dialogue" || p.type === "lyrics") && (p === target || visible(p.runs).text.trim()));
    if (dialogue.length === 1) {
      cut = "speech";
      removed = speech.paragraphs.filter((p) => !NON_PRINTING.has(p.type));
    } else {
      const previous = speech.paragraphs[speech.paragraphs.indexOf(target) - 1];
      if (previous?.type === "parenthetical") removed = [previous, target];
    }
  }
  if (removed.some((p) => p.runs.some((run) => run.note) || hasScriptNote(p)) || speech?.paragraphs.some((p) => p.type === "note")) {
    return { error: "That passage has a private note in it. Cut it by hand." };
  }
  if (suggestion.cut && suggestion.cut !== cut) return { error: "That speech has changed, so the cut can't be applied. Propose it again." };
  return { cut, paragraphIds: removed.map((p) => p.id) };
}
