// What the assistant is told: its rules, the script as Fountain trimmed to a budget with the current scene always
// included, and optionally the writer's selection. Pure functions, so the budget logic is tested without a window.
import { type Paragraph, type Script, plainText, scenesOf, writeFountain } from "@screenplay/engine";

export const ASSISTANT_PROMPT = [
  "You answer questions about the screenplay below for the writer who is working on it.",
  "- Be concise and factual. No flattery, no drama, no hype.",
  "- Answer what was asked. Give no story notes, criticism or ideas unless asked for them.",
  "- Cite scenes by number and heading, like: Scene 12 (INT. WAREHOUSE - NIGHT).",
  "- If the script or the production data does not say, say that. Do not guess.",
  "- Production data, when present, comes from the writer's Backlot project and is read-only fact: breakdown elements, cast and shoot days.",
  "- You cannot change the script. When a change would help, do not describe it as made. Offer it as a block the writer can apply, with `find` copied exactly from one line of the script:",
  "```suggestion",
  '{"scene":"12","find":"exact text from one line","replace":"new text","why":"short reason"}',
  "```",
].join("\n");

export const QUICK_ACTIONS = {
  notes: (scene: string) => `Give notes on ${scene}. Cover clarity, pacing and character. Five bullet points at most, each one specific to the page.`,
  summarize: (scene: string) => `Summarize ${scene} in two or three sentences. Facts only.`,
  continuity: () => "List continuity issues you can find across the script: names, timeline, props, locations, who knows what. Cite the scenes. If you find none, say so.",
} as const;

export interface ScriptContext {
  text: string;
  /** Scenes whose full text is included, and how many there are. */
  included: number;
  total: number;
  truncated: boolean;
  /** "Scene 4 (INT. KITCHEN - DAY)" for the scene holding the caret, or null for a script with no scenes. */
  current: string | null;
}

interface SceneChunk {
  label: string;
  heading: string;
  text: string;
  /** Paragraph IDs in the scene. */
  ids: Set<string>;
}

function fountainOf(paragraphs: Paragraph[]): string {
  return writeFountain({ titlePage: [], paragraphs }).trim();
}

export function sceneLabel(number: string | undefined, ordinal: number, heading: string): string {
  return `Scene ${number || ordinal} (${heading.trim() || "untitled"})`;
}

/**
 * The script as Fountain, scene by scene, each introduced by a marker line the model can cite. When the whole
 * script is over budget, the current scene and its nearest neighbours are kept in full and the rest are listed
 * by heading only.
 */
export function buildScriptContext(script: Script, currentParagraphId: string | null, budget: number): ScriptContext {
  const scenes = scenesOf(script.paragraphs);
  const chunks: SceneChunk[] = [];
  const first = scenes[0]?.start ?? script.paragraphs.length;
  if (first > 0) {
    const lead = script.paragraphs.slice(0, first);
    chunks.push({ label: "Before the first scene", heading: "", text: fountainOf(lead), ids: new Set(lead.map((p) => p.id)) });
  }
  scenes.forEach((scene, index) => {
    const paragraphs = script.paragraphs.slice(scene.start, scene.end);
    const label = sceneLabel(scene.number, index + 1, scene.heading);
    chunks.push({ label, heading: scene.heading, text: fountainOf(paragraphs), ids: new Set(paragraphs.map((p) => p.id)) });
  });
  const currentIndex = Math.max(0, chunks.findIndex((chunk) => currentParagraphId !== null && chunk.ids.has(currentParagraphId)));
  const sceneChunks = chunks.filter((chunk) => chunk.heading);
  const current = chunks.length ? chunks[currentIndex]!.label : null;
  const render = (chunk: SceneChunk) => `[${chunk.label}]\n${chunk.text}`;
  const full = chunks.map(render).join("\n\n");
  if (full.length <= budget) return { text: full, included: sceneChunks.length, total: sceneChunks.length, truncated: false, current };

  // Over budget: an outline of every scene, then full text by distance from the current scene.
  const outline = `[Outline of all scenes]\n${chunks.map((chunk) => `- ${chunk.label}`).join("\n")}`;
  let remaining = budget - outline.length;
  const chosen = new Set<number>();
  const order = chunks.map((_, index) => index).sort((a, b) => Math.abs(a - currentIndex) - Math.abs(b - currentIndex) || a - b);
  for (const index of order) {
    const size = render(chunks[index]!).length + 2;
    // The current scene is always in, even if it alone is over budget.
    if (index !== currentIndex && size > remaining) continue;
    chosen.add(index);
    remaining -= size;
  }
  const body = chunks.map((chunk, index) => (chosen.has(index) ? render(chunk) : null)).filter(Boolean).join("\n\n");
  const included = [...chosen].filter((index) => chunks[index]!.heading).length;
  return {
    text: `${outline}\n\n[Full text of ${included} of ${sceneChunks.length} scenes follows; the others are in the outline only. Say so if a question needs a scene that is missing.]\n\n${body}`,
    included, total: sceneChunks.length, truncated: true, current,
  };
}

export interface PromptParts {
  context: ScriptContext;
  selection?: string;
}

export function assistantSystem({ context, selection }: PromptParts): string {
  const parts = [ASSISTANT_PROMPT, "SCRIPT (Fountain):", context.text];
  if (context.current) parts.push(`The writer is working in ${context.current}.`);
  if (selection?.trim()) parts.push(`The writer has selected this text:\n"""\n${selection.trim().slice(0, 4000)}\n"""`);
  return parts.join("\n\n");
}

/** The text of a selection, from the editor's anchor and head, or "" when it is collapsed or spans nothing. */
export function selectedText(script: Script, from: { paragraphId: string; offset: number }, to: { paragraphId: string; offset: number }): string {
  const index = new Map(script.paragraphs.map((paragraph, i) => [paragraph.id, i]));
  let a = from, b = to;
  const ai = index.get(a.paragraphId), bi = index.get(b.paragraphId);
  if (ai === undefined || bi === undefined) return "";
  if (ai > bi || (ai === bi && a.offset > b.offset)) [a, b] = [b, a];
  const start = index.get(a.paragraphId)!;
  const end = index.get(b.paragraphId)!;
  const pieces: string[] = [];
  for (let i = start; i <= end; i++) {
    const text = plainText(script.paragraphs[i]!.runs);
    pieces.push(text.slice(i === start ? a.offset : 0, i === end ? b.offset : text.length));
  }
  return pieces.join("\n");
}
