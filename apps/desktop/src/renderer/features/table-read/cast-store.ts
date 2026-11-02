// Cast fields use separate meta keys so disconnected writers can edit the same role without replacing maps.
// Legacy rows stay live defaults, read on every call. A v3 field wins only where a writer set that exact key.
import { type CastBinding, type ScreenplayDoc } from "@screenplay/engine";
import * as Y from "yjs";

import { isReadEngine } from "../../../shared/channels/table-read.ts";
import { parseCast, type CastState } from "./casting.ts";

export const LEGACY_CAST_KEY = "tableRead.cast.v1";
const FIELD_PREFIX = "tableRead.cast.v3.character.";
const CHARACTER_PREFIX = "tableRead.cast.v2.character.";
const NARRATOR_PREFIX = "tableRead.cast.v2.narrator.";
const IGNORED_PREFIX = "tableRead.cast.v2.ignored.";

export interface StoredCharacter {
  id: string;
  name: string;
  aliases: string[];
  cueIds?: string[];
  locked: boolean;
  voices: Record<string, string>;
}

export interface StoredCast {
  narrator: Record<string, string>;
  characters: StoredCharacter[];
  /** JSON-encoded `[characterId, name]` pairs the writer marked as different people. */
  ignoredAliases: string[];
}

/** The parts of a document session a cast write needs. Read-only sessions are refused, never mutated. */
export interface CastSession {
  readonly doc: ScreenplayDoc;
  readonly readOnly: boolean;
  edit<T>(change: () => T): T;
}

export interface CastWrite {
  narrator?: Readonly<Record<string, string>>;
  /** Only the named characters and voice keys are written; everything else is left to other writers. */
  characters?: readonly StoredCharacter[];
  ignoredAliases?: readonly string[];
}

const isMap = (value: unknown): value is Y.Map<unknown> => value instanceof Y.Map;
const isArray = (value: unknown): value is Y.Array<unknown> => value instanceof Y.Array;
export const aliasKey = (characterId: string, name: string) => JSON.stringify([characterId, name]);
const ignoredKey = (characterId: string, name: string) => `${IGNORED_PREFIX}${aliasKey(characterId, name)}`;

function cleanVoice(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 120 && !/[\u0000-\u001f]/.test(value) ? value : undefined;
}

function readVoices(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isMap(value) || value instanceof Map) for (const [engine, voice] of value.entries()) {
    if (!isReadEngine(engine)) continue;
    const clean = cleanVoice(voice);
    if (clean !== undefined) out[engine] = clean;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** A history restore flattens nested Yjs maps to plain JSON, so a legacy row may be either shape. */
function readCharacter(id: string, value: unknown): StoredCharacter | null {
  const plain = !isMap(value) && !!value && typeof value === "object" && !Array.isArray(value);
  if ((!isMap(value) && !plain) || !id || id.length > 160) return null;
  const get = (key: string): unknown => isMap(value) ? value.get(key) : (value as Record<string, unknown>)[key];
  const name = get("name");
  if (typeof name !== "string" || !name || name.length > 160) return null;
  const rawAliases = get("aliases"), rawCues = get("cueIds"), rawVoices = get("voices");
  const aliasArray = isArray(rawAliases) ? rawAliases.toArray() : Array.isArray(rawAliases) ? rawAliases : null;
  const cueArray = isArray(rawCues) ? rawCues.toArray() : Array.isArray(rawCues) ? rawCues : null;
  const voiceMap = plain && rawVoices && typeof rawVoices === "object" && !Array.isArray(rawVoices)
    ? new Map(Object.entries(rawVoices)) : rawVoices;
  return {
    id, name,
    aliases: aliasArray ? aliasArray
      .filter((v): v is string => typeof v === "string" && !!v && v.length <= 160).slice(0, 20) : [],
    cueIds: cueArray ? cueArray
      .filter((id): id is string => typeof id === "string" && id.length <= 160).slice(0, 10_000) : [],
    locked: get("locked") === true,
    voices: readVoices(voiceMap),
  };
}

function parseIgnored(key: string): string | null {
  if (!key.startsWith(IGNORED_PREFIX)) return null;
  try {
    const pair: unknown = JSON.parse(key.slice(IGNORED_PREFIX.length));
    return Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string" && part.length <= 400)
      ? aliasKey(pair[0] as string, pair[1] as string) : null;
  } catch { return null; }
}

function legacyCast(value: unknown): StoredCast {
  if (!value) return { narrator: {}, characters: [], ignoredAliases: [] };
  const parsed = parseCast(value);
  return {
    narrator: parsed.narrator,
    characters: parsed.cast.map((binding) => ({
      ...binding, aliases: [...binding.aliases], cueIds: [...binding.cueIds], voices: { ...binding.voices },
    })),
    ignoredAliases: [],
  };
}

const fieldKey = (id: string, field: string) => `${FIELD_PREFIX}${JSON.stringify([id, field])}`;

function fieldPair(key: string): [string, string] | null {
  try {
    const pair: unknown = JSON.parse(key.slice(FIELD_PREFIX.length));
    return Array.isArray(pair) && pair.length === 2
      && pair.every((part) => typeof part === "string" && part.length <= 400)
      ? pair as [string, string] : null;
  } catch { return null; }
}

/** Read old rows as defaults and overlay only the fields writers have edited. Never writes. */
export function readStoredCast(doc: ScreenplayDoc): StoredCast {
  const legacy = legacyCast(doc.meta.get(LEGACY_CAST_KEY));
  const narrator = { ...legacy.narrator };
  const characters = new Map(legacy.characters.map((row) => [row.id, row]));
  const ignored: string[] = [];
  const fields = new Map<string, Map<string, unknown>>();
  for (const [key, value] of doc.meta.entries()) {
    if (key.startsWith(FIELD_PREFIX)) {
      const pair = fieldPair(key);
      if (!pair) continue;
      const [id, field] = pair;
      let row = fields.get(id);
      if (!row) fields.set(id, row = new Map());
      row.set(field, value);
    } else if (key.startsWith(NARRATOR_PREFIX)) {
      const engine = key.slice(NARRATOR_PREFIX.length);
      const voice = isReadEngine(engine) ? cleanVoice(value) : undefined;
      if (voice !== undefined) narrator[engine] = voice;
    } else if (key.startsWith(CHARACTER_PREFIX)) {
      const character = readCharacter(key.slice(CHARACTER_PREFIX.length), value);
      if (character) characters.set(character.id, character);
    } else if (key.startsWith(IGNORED_PREFIX)) {
      const pair = parseIgnored(key);
      if (pair && value === true) ignored.push(pair);
    }
  }
  for (const [id, row] of fields) {
    if (row.get("deleted") === true) { characters.delete(id); continue; }
    // The base is the live v1/v2 row, so an older peer's later edit still shows through fields v3 never wrote.
    const base = characters.get(id);
    const name = row.get("name") ?? base?.name;
    if (typeof name !== "string" || !name || name.length > 160 || !id || id.length > 160) continue;
    const aliases = new Set(base?.aliases ?? []), cueIds = new Set(base?.cueIds ?? []);
    const voices = { ...base?.voices };
    for (const [field, value] of row) {
      if (field.startsWith("voice.")) {
        const engine = field.slice(6), voice = cleanVoice(value);
        if (isReadEngine(engine) && voice !== undefined) voices[engine] = voice;
      } else if (field.startsWith("alias.") && value === true) aliases.add(field.slice(6));
      else if (field.startsWith("cue.") && value === true) cueIds.add(field.slice(4));
    }
    characters.set(id, {
      id, name, aliases: [...aliases].filter((alias) => alias && alias !== name && alias.length <= 160).sort().slice(0, 20),
      cueIds: [...cueIds].filter((cue) => cue && cue.length <= 160).sort().slice(0, 10_000),
      locked: row.has("locked") ? row.get("locked") === true : base?.locked === true,
      voices: Object.fromEntries(Object.entries(voices).sort(([a], [b]) => a.localeCompare(b))),
    });
  }
  return {
    narrator: Object.fromEntries(Object.entries(narrator).sort(([a], [b]) => a.localeCompare(b))),
    characters: [...characters.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ignoredAliases: ignored.sort(),
  };
}

/** Listen for any nested cast change. Returns the unsubscribe function. */
export function observeCast(doc: ScreenplayDoc, notify: () => void): () => void {
  doc.meta.observeDeep(notify);
  return () => doc.meta.unobserveDeep(notify);
}

function writeCharacter(doc: ScreenplayDoc, character: StoredCharacter): void {
  const key = (field: string) => fieldKey(character.id, field);
  const previous = readStoredCast(doc).characters.find((row) => row.id === character.id);
  if (doc.meta.get(key("deleted")) === true) doc.meta.set(key("deleted"), false);
  // Identity lives in v3 too, so these fields never depend on a legacy row that a restore or an old peer may drop.
  if (character.name && (character.name !== previous?.name || !doc.meta.has(key("name")))) doc.meta.set(key("name"), character.name);
  if (character.locked !== (previous?.locked ?? false)) doc.meta.set(key("locked"), character.locked);
  for (const alias of character.aliases) {
    if (alias && alias !== character.name) doc.meta.set(key(`alias.${alias}`), true);
  }
  for (const id of character.cueIds ?? []) doc.meta.set(key(`cue.${id}`), true);
  for (const [engine, voice] of Object.entries(character.voices)) {
    if (isReadEngine(engine) && cleanVoice(voice) !== undefined && voice !== previous?.voices[engine]) {
      doc.meta.set(key(`voice.${engine}`), voice);
    }
  }
}

/**
 * Write a patch. Read-only sessions return false without touching the document. Diffing per character and
 * per engine is what keeps two writers' edits to different characters: no write replaces the whole cast.
 */
export function writeCast(session: CastSession, write: CastWrite): boolean {
  if (session.readOnly) return false;
  session.edit(() => {
    if (write.narrator) {
      for (const [engine, voice] of Object.entries(write.narrator)) {
        if (isReadEngine(engine) && cleanVoice(voice) !== undefined) {
          session.doc.meta.set(`${NARRATOR_PREFIX}${engine}`, voice);
        }
      }
    }
    for (const character of write.characters ?? []) writeCharacter(session.doc, character);
    for (const key of write.ignoredAliases ?? []) {
      if (key.length <= 400) session.doc.meta.set(`${IGNORED_PREFIX}${key}`, true);
    }
  });
  return true;
}

export function storedCharacters(state: CastState): StoredCharacter[] {
  return state.cast.map((binding) => storedCharacter(binding, { ...binding.voices }));
}

/** Replace all cast rows; used by import and by a deliberate whole-ensemble assignment. */
export function writeCastState(session: CastSession, state: CastState): boolean {
  return writeCast(session, { narrator: state.narrator, characters: storedCharacters(state) });
}

/** Convert a binding the UI holds into the row a patch writes. */
export function storedCharacter(binding: CastBinding, voices: Record<string, string> = binding.voices): StoredCharacter {
  return {
    id: binding.id, name: binding.name, aliases: [...binding.aliases],
    cueIds: [...binding.cueIds], locked: binding.locked, voices,
  };
}

export function ignoreAlias(session: CastSession, characterId: string, name: string): boolean {
  return writeCast(session, { ignoredAliases: [aliasKey(characterId, name)] });
}

/**
 * The writer confirmed two names are one person. Voices move to the kept character only where it has no voice
 * for that engine; a lock on either row keeps the kept row locked. `known` supplies rows the UI has not written
 * yet, so confirming an alias before any other cast edit still works.
 */
export function mergeStoredCharacters(
  session: CastSession, fromId: string, intoId: string, known: readonly StoredCharacter[] = [],
): boolean {
  if (session.readOnly || fromId === intoId) return false;
  const current = readStoredCast(session.doc);
  const from = current.characters.find((c) => c.id === fromId) ?? known.find((c) => c.id === fromId);
  const into = current.characters.find((c) => c.id === intoId) ?? known.find((c) => c.id === intoId);
  if (!from || !into) return false;
  session.edit(() => {
    writeCharacter(session.doc, {
      ...into,
      aliases: [...new Set([...into.aliases, from.name, ...from.aliases])],
      cueIds: [...new Set([...(into.cueIds ?? []), ...(from.cueIds ?? [])])],
      locked: into.locked || from.locked,
      voices: { ...from.voices, ...into.voices },
    });
    session.doc.meta.set(fieldKey(fromId, "deleted"), true);
    session.doc.meta.delete(ignoredKey(intoId, from.name));
  });
  return true;
}
