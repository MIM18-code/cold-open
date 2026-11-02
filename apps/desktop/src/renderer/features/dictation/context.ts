// What the formatting model is told about the script: the scene so far, who is in the story, and who has
// already walked on. Pure functions over a plain Script so they run in tests without the app.
import { type Paragraph, type Script, plainText } from "@screenplay/engine";

import { EMPTY_CONTEXT, type TakeContext, fromEngineType } from "../../../shared/channels/dictation.ts";

const REFERENCE_CHARS = 1500;
const PREVIOUS_ELEMENTS = 6;
const MAX_NAMES = 60;
const MAX_LOCATIONS = 40;
const SKIPPED: ReadonlySet<string> = new Set(["section", "synopsis", "castList", "newAct", "endOfAct"]);

/** "MAYA (V.O.)", "Maya (CONT'D)" and "MAYA ^" are all MAYA. */
export function cueName(text: string): string {
  return text.replace(/\s*\^\s*$/, "").replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}

/** "INT. MAYA'S KITCHEN - NIGHT" gives "MAYA'S KITCHEN". */
export function locationName(heading: string): string {
  return heading
    .replace(/^\s*(?:INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.?|EXT\.?)\s+/i, "")
    .replace(/\s+[-–—]\s+[^-–—]*$/, "")
    .replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * The most useful names first, up to `limit`: those in `local` (the current scene), then by how often the
 * script uses them, then by first appearance. A long script has more names than the prompt should carry, and
 * the cast of the scene being dictated must never be the ones left out.
 */
function ranked(values: string[], local: ReadonlySet<string>, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  const order = [...counts.keys()];
  if (order.length <= limit) return order;
  return order
    .map((name, first) => ({ name, first, count: counts.get(name)!, here: local.has(name) }))
    .sort((a, b) => Number(b.here) - Number(a.here) || b.count - a.count || a.first - b.first)
    .slice(0, limit)
    .map((entry) => entry.name);
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}'])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * The context for a take that will go after `paragraphId` (the end of the script when it is null or unknown).
 * `offset` cuts that paragraph at the caret, so only text before the caret is shown to the model.
 */
export function buildTakeContext(script: Script, paragraphId: string | null, offset?: number): TakeContext {
  const all = script.paragraphs;
  if (!all.length) return { ...EMPTY_CONTEXT };
  const found = paragraphId ? all.findIndex((p) => p.id === paragraphId) : -1;
  const at = found >= 0 ? found : all.length - 1;
  const textOf = (p: Paragraph, index: number): string => {
    const text = plainText(p.runs);
    return index === at && found >= 0 && offset !== undefined ? text.slice(0, offset) : text;
  };

  let start = at;
  while (start > 0 && all[start]!.type !== "sceneHeading") start--;
  let end = at + 1;
  while (end < all.length && all[end]!.type !== "sceneHeading") end++;

  const cues = all.filter((p) => p.type === "character").map((p) => cueName(plainText(p.runs)));
  const inScene = new Set(all.slice(start, end).filter((p) => p.type === "character").map((p) => cueName(plainText(p.runs))));
  const characters = ranked(cues, inScene, MAX_NAMES);
  const heading = all[start]!.type === "sceneHeading" ? plainText(all[start]!.runs).trim() : "";
  const locations = ranked(all.filter((p) => p.type === "sceneHeading").map((p) => locationName(plainText(p.runs))),
    new Set(heading ? [locationName(heading)] : []), MAX_LOCATIONS);
  const scene = all.slice(start, at + 1)
    .map((p, i) => ({ type: p.type, text: textOf(p, start + i).trim() }))
    .filter((p) => p.text && !SKIPPED.has(p.type));

  const before = all.slice(0, at + 1).map((p, i) => ({ type: p.type, text: textOf(p, i) }));
  const introduced = characters.filter((name) => before.some((p) =>
    (p.type === "character" && cueName(p.text) === name) || (p.type === "action" && mentions(p.text, name))));

  return {
    characters,
    locations,
    currentHeading: heading,
    referenceText: scene.map((p) => p.text).join("\n").slice(-REFERENCE_CHARS),
    previousElements: scene.slice(-PREVIOUS_ELEMENTS).map((p) => ({
      type: fromEngineType(p.type),
      text: p.type === "parenthetical" ? p.text.replace(/^\(|\)$/g, "") : p.text,
    })),
    introduced,
  };
}
