// Source-linked, deterministic speech planning. A language model never rewrites the script.
import { buildCharacterRegistry, NARRATOR, type CharacterIdentity } from "./characters.ts";
import { NON_PRINTING, type Paragraph, type Script } from "./model.ts";
import { characterName } from "./reports.ts";
export { NARRATOR } from "./characters.ts";
export interface ReadOptions { action: boolean; headings: boolean; parentheticals: boolean; names: boolean; }
export const DEFAULT_READ_OPTIONS: ReadOptions = { action: true, headings: false, parentheticals: false, names: false };
export interface SourceSpan { paragraphId: string; from: number; to: number; }
export interface ReadCue {
  id: string; paragraphIds: string[]; sceneId: string | null; sceneHeading: string;
  speaker: string; kind: "dialogue" | "narration"; text: string; source: SourceSpan[]; dual?: string; lane?: 1 | 2;
}
export interface ReadRole { id: string; name: string; aliases: string[]; cueIds: string[]; sample: string; }
export const spokenText = (p: Paragraph) => p.runs.filter((r) => !r.note).map((r) => r.text).join("");
/** Bounded chunks, never truncate or change wording. Model backends may normalize punctuation independently. */
export function speechChunks(text: string, limit = 900): string[] {
  if (!Number.isInteger(limit) || limit < 32) throw new Error("Invalid speech chunk limit.");
  const result: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const prefix = rest.slice(0, limit + 1);
    const boundaries = [...prefix.matchAll(/[.!?;]\s+|\n+/g)].map((m) => m.index! + m[0].length);
    let at = boundaries.filter((i) => i <= limit && i >= limit / 3).at(-1) ?? prefix.lastIndexOf(" ", limit);
    if (at < 1) at = limit;
    // Do not split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(rest[at - 1]!)) at--;
    result.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim();
  }
  if (rest) result.push(rest);
  return result;
}
export function readRoles(script: Script, confirmed: readonly CharacterIdentity[] = []): ReadRole[] {
  const registry = buildCharacterRegistry(script, confirmed);
  const owner = new Map<string, CharacterIdentity>();
  for (const character of registry.characters) for (const id of character.cueIds) owner.set(id, character);
  const roles = new Map<string, ReadRole>(); let current: ReadRole | undefined;
  for (const p of script.paragraphs) {
    if (p.type === "character") {
      const name = characterName(spokenText(p));
      const identity = name ? owner.get(p.id) : undefined;
      current = identity ? roles.get(identity.id) : undefined;
      if (identity && !current) {
        current = { id: identity.id, name: identity.displayName, aliases: [...identity.aliases], cueIds: [], sample: "" };
        roles.set(identity.id, current);
      }
      current?.cueIds.push(p.id);
    } else if (p.type === "dialogue" || p.type === "lyrics") {
      if (current && current.sample.length < 600) current.sample = `${current.sample} ${spokenText(p)}`.trim().slice(0, 600);
    } else if (p.type !== "parenthetical" && !NON_PRINTING.has(p.type)) current = undefined;
  }
  return [...roles.values()].filter((r) => r.sample);
}
export function compileReadPlan(script: Script, options: ReadOptions = DEFAULT_READ_OPTIONS): ReadCue[] {
  const cues: ReadCue[] = [];
  let speaker = NARRATOR, sceneId: string | null = null, sceneHeading = "";
  let omitted = false;
  let previousDialogue = false;
  const add = (p: Paragraph, text: string, role: string, kind: ReadCue["kind"]) => {
    const offsets: number[] = [];
    let offset = 0;
    for (const run of p.runs) {
      if (!run.note) for (let i = 0; i < run.text.length; i++) offsets.push(offset + i);
      offset += run.text.length;
    }
    const original = spokenText(p);
    let cursor = 0;
    speechChunks(text).forEach((chunk, i) => {
      const at = original.indexOf(chunk, cursor);
      const source: SourceSpan[] = [];
      if (at >= 0) {
        for (const position of offsets.slice(at, at + chunk.length)) {
          const last = source.at(-1);
          if (last?.to === position) last.to++;
          else source.push({ paragraphId: p.id, from: position, to: position + 1 });
        }
        cursor = at + chunk.length;
      } else {
        // Heading expansion and optional cue normalization retain the original passage.
        for (const position of offsets) {
          const last = source.at(-1);
          if (last?.to === position) last.to++;
          else source.push({ paragraphId: p.id, from: position, to: position + 1 });
        }
      }
      const last = cues.at(-1);
      if (previousDialogue && kind === "dialogue" && last?.speaker === role
        && last.dual === p.dual?.block && last.lane === p.dual?.side
        && last.text.length + chunk.length + 1 <= 900) {
        last.text += " " + chunk;
        last.source!.push(...source);
        if (!last.paragraphIds.includes(p.id)) last.paragraphIds.push(p.id);
      } else {
        cues.push({ id: `${p.id}:${kind}:${i}`, paragraphIds: [p.id], source, sceneId, sceneHeading,
          speaker: role, kind, text: chunk, ...(p.dual ? { dual: p.dual.block, lane: p.dual.side } : {}) });
      }
    });
  };
  for (const p of script.paragraphs) {
    const text = spokenText(p).trim();
    // Page labels a PDF or pasted script left behind as their own paragraphs: uppercase only, and never dialogue or
    // lyrics, where "More." or "Continued" is something a character says.
    if (p.type !== "dialogue" && p.type !== "lyrics" && /^\(?\s*(?:MORE|CONT[’']D|CONTINUED)\s*\)?:?$/.test(text)) continue;
    if (NON_PRINTING.has(p.type)) continue;
    if (p.type !== "dialogue" && p.type !== "lyrics") previousDialogue = false;
    if (p.type === "sceneHeading") {
      sceneId = p.sceneId ?? p.id; sceneHeading = text; speaker = NARRATOR;
      omitted = /^OMITTED(?:\s|$)/i.test(text);
      if (text && !omitted && options.headings) add(p, text.replace(/^INT\./i, "Interior.").replace(/^EXT\./i, "Exterior."), NARRATOR, "narration");
      continue;
    }
    if (omitted) continue;
    if (p.type === "character") {
      speaker = characterName(text) || NARRATOR;
      if (options.names && text) add(p, speaker, NARRATOR, "narration");
    } else if (p.type === "dialogue" || p.type === "lyrics") {
      if (text) add(p, text, speaker, "dialogue");
      previousDialogue = true;
    } else if (p.type === "parenthetical") {
      // Stage directions are never passed to a voice model as undocumented performance tags.
      if (options.parentheticals && text) add(p, text.replace(/^\(|\)$/g, ""), NARRATOR, "narration");
    } else {
      speaker = NARRATOR;
      if (options.action && text && ["action", "general", "shot"].includes(p.type)) add(p, text, NARRATOR, "narration");
    }
  }
  return cues;
}
export interface CastBinding { id: string; name: string; aliases: string[]; cueIds: string[]; voices: Record<string, string>; locked: boolean; }
/** Matching cue IDs preserves a voice through Rename Character; aliases and names are fallbacks for external imports. */
export function reconcileCast(roles: ReadRole[], previous: readonly CastBinding[]): CastBinding[] {
  const used = new Set<string>();
  return roles.map((r) => {
    const old = previous.find((b) => !used.has(b.id) && b.cueIds.some((id) => r.cueIds.includes(id)))
      ?? previous.find((b) => !used.has(b.id) && (b.id === r.id || b.name === r.name || b.aliases.includes(r.name) || r.aliases.includes(b.name)));
    if (old) used.add(old.id);
    return { id: r.id, name: r.name, aliases: [...r.aliases], cueIds: [...r.cueIds], voices: { ...old?.voices }, locked: old?.locked ?? false };
  });
}
