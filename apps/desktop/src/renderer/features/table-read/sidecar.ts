// Table-read data for an FDX or Fountain working file. Those formats have no place for voice assignments,
// pronunciations or listening notes, so the writer can keep a versioned sidecar next to the script instead.
//
// Matching never trusts the filename. A reopened script is compared through paragraph IDs (FDX keeps them),
// character names and fingerprints of the cue text and the lines under each cue. Fountain regenerates every
// paragraph ID on import, so its sidecar stores names and fingerprints only. An exact match attaches without a
// question; a partial one opens a reviewed remapping; no match leaves both files alone and says so.
import {
  buildCharacterRegistry, fingerprintOf, NON_PRINTING, plainText,
  type CharacterIdentity, type Paragraph, type ScreenplayDoc, type Script,
} from "@screenplay/engine";

import { isReadEngine } from "../../../shared/channels/table-read.ts";
import type { DocumentSession } from "../../core/session.ts";
import { anchorAt, createRecord, putRecord, records, type ProjectRecord } from "../rewrite/records.ts";
import { readStoredCast, writeCast, type StoredCast, type StoredCharacter } from "./cast-store.ts";
import { parsePronunciations, PRONUNCIATION_KEY, type Pronunciation } from "./pronunciation.ts";

export const SIDECAR_VERSION = 1;

export type SidecarFormat = "fdx" | "fountain";

export interface CharacterSource {
  id: string;
  name: string;
  aliases: string[];
  /** Empty for Fountain: its paragraph IDs are regenerated on every open. */
  cueIds: string[];
  /** Cue names plus every line under them. */
  fingerprint: string;
  /** The lines alone, used when a name changed but the dialogue did not. */
  lineFingerprint: string;
  cueCount: number;
  lineCount: number;
}

export interface SourceManifest {
  format: SidecarFormat;
  fingerprint: string;
  characters: CharacterSource[];
}

export interface NoteAnchor {
  paragraphId: string;
  from: number;
  to: number;
  quote: string;
}

export interface SidecarNote {
  title: string;
  text: string;
  created: string;
  updated: string;
  anchor: NoteAnchor;
  readSession?: { id: string; revision: string; spokenText?: string };
}

export interface TableReadSidecar {
  format: "inklot.table-read";
  version: 1;
  /** Stable for this working file; kept across sidecar rewrites. */
  projectId: string;
  created: string;
  updated: string;
  source: SourceManifest;
  cast: { narrator: Record<string, string>; characters: StoredCharacter[]; ignoredAliases: string[] };
  pronunciations: Pronunciation[];
  notes: SidecarNote[];
}

export interface CharacterMatch {
  storedId: string;
  storedName: string;
  currentId: string | null;
  currentName: string | null;
  strength: "exact" | "changed" | "inferred";
  strong: boolean;
  reason: string;
}

export interface SidecarMatch {
  kind: "exact" | "partial" | "mismatch";
  pairs: CharacterMatch[];
  /** Characters in the script right now, for the review's menus. */
  current: { id: string; name: string }[];
  message: string;
}

export interface ApplyResult {
  applied: boolean;
  characters: number;
  pronunciations: number;
  notes: number;
  detachedNotes: number;
  reason?: string;
}

export interface RestoreProps {
  sessionId: string;
  sidecar: TableReadSidecar;
  match: SidecarMatch;
  source: "sidecar" | "bundle";
}

interface ReadSessionRecord extends ProjectRecord {
  readSession?: { id?: unknown; revision?: unknown; spokenText?: unknown };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function keysOf(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field "${key}" in this ${where}.`);
}

function textOf(value: unknown, limit: number, where: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > limit || (!allowEmpty && !value.trim())) throw new Error(`Invalid ${where}.`);
  return value;
}

function integerOf(value: unknown, limit: number, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > limit) throw new Error(`Invalid ${where}.`);
  return value;
}

function stringArray(value: unknown, limit: number, itemLimit: number, where: string): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some((item) => typeof item !== "string" || item.length > itemLimit)) {
    throw new Error(`Invalid ${where}.`);
  }
  return [...value] as string[];
}

function paragraphText(paragraph: Paragraph): string {
  return paragraph.runs.filter((run) => !run.note).map((run) => run.text).join("");
}

/** The source shape of one character: its cue names and the lines beneath them. */
function sourceOf(script: Script, identity: CharacterIdentity, recordCueIds: boolean): CharacterSource {
  const cueIds = new Set(identity.cueIds), cues: string[] = [], lines: string[] = [];
  let current = false;
  for (const paragraph of script.paragraphs) {
    if (paragraph.type === "character") {
      current = cueIds.has(paragraph.id);
      if (current) cues.push(paragraphText(paragraph).trim());
      continue;
    }
    if (paragraph.type === "dialogue" || paragraph.type === "lyrics") {
      if (current) {
        const line = paragraphText(paragraph).trim();
        if (line) lines.push(line);
      }
      continue;
    }
    if (paragraph.type === "parenthetical" || NON_PRINTING.has(paragraph.type)) continue;
    current = false;
  }
  return {
    id: identity.id,
    name: identity.displayName,
    aliases: [...identity.aliases],
    cueIds: recordCueIds ? [...identity.cueIds] : [],
    fingerprint: fingerprintOf([...cues, "\u0002", ...lines].join("\u0001")),
    lineFingerprint: fingerprintOf(lines.join("\u0001")),
    cueCount: cues.length,
    lineCount: lines.length,
  };
}

/**
 * Character fingerprints for matching. `identities` seeds the registry so a stored alias or a surviving cue
 * paragraph keeps its durable character ID. Fountain rows deliberately carry no cue IDs.
 */
export function buildSourceManifest(script: Script, format: SidecarFormat, identities: readonly CharacterIdentity[] = []): SourceManifest {
  const registry = buildCharacterRegistry(script, identities);
  const characters = registry.characters.map((identity) => sourceOf(script, identity, format === "fdx"));
  return {
    format,
    fingerprint: fingerprintOf(characters.map((row) => `${row.name}\u0001${row.fingerprint}\u0001${row.lineFingerprint}`).join("\u0002")),
    characters,
  };
}

function listeningNotes(doc: ScreenplayDoc): SidecarNote[] {
  return records(doc, "note").flatMap((raw) => {
    const record = raw as ReadSessionRecord;
    const session = record.readSession, anchor = record.anchor;
    if (!session || !anchor || typeof anchor.paragraphId !== "string" || typeof anchor.quote !== "string") return [];
    const out: SidecarNote = {
      title: record.title.slice(0, 160), text: record.text.slice(0, 20_000),
      created: record.created, updated: record.updated,
      anchor: {
        paragraphId: anchor.paragraphId,
        from: Math.max(0, Math.min(anchor.from, anchor.to)),
        to: Math.max(0, Math.max(anchor.from, anchor.to)),
        quote: anchor.quote.slice(0, 20_000),
      },
    };
    if (typeof session.id === "string" && typeof session.revision === "string") {
      out.readSession = {
        id: session.id.slice(0, 200),
        revision: session.revision.slice(0, 200),
        ...(typeof session.spokenText === "string" ? { spokenText: session.spokenText.slice(0, 20_000) } : {}),
      };
    }
    return [out];
  });
}

/** Whether this document holds anything an FDX or Fountain file cannot carry. */
export function hasTableReadData(doc: ScreenplayDoc): boolean {
  const cast = readStoredCast(doc);
  return cast.characters.length > 0 || Object.keys(cast.narrator).length > 0
    || parsePronunciations(doc.meta.get(PRONUNCIATION_KEY)).length > 0
    || listeningNotes(doc).length > 0;
}

export function buildSidecar(
  session: DocumentSession, options: { projectId: string; created?: string },
): TableReadSidecar {
  if (session.format !== "fdx" && session.format !== "fountain") throw new Error("Table-read files are for FDX and Fountain scripts.");
  const script = session.script(), format = session.format;
  const cast = readStoredCast(session.doc);
  const now = new Date().toISOString();
  return {
    format: "inklot.table-read",
    version: SIDECAR_VERSION,
    projectId: options.projectId,
    created: options.created ?? now,
    updated: now,
    source: buildSourceManifest(script, format),
    cast: {
      narrator: { ...cast.narrator },
      characters: cast.characters.map((character) => ({ ...character, aliases: [...character.aliases], voices: { ...character.voices } })),
      ignoredAliases: [...cast.ignoredAliases],
    },
    pronunciations: parsePronunciations(session.doc.meta.get(PRONUNCIATION_KEY)),
    notes: listeningNotes(session.doc),
  };
}

// ---------- validation ----------

function parseCharacterSource(value: unknown): CharacterSource {
  if (!object(value)) throw new Error("Invalid character entry in the table-read file.");
  keysOf(value, ["id", "name", "aliases", "cueIds", "fingerprint", "lineFingerprint", "cueCount", "lineCount"], "character entry");
  return {
    id: textOf(value.id, 160, "character ID"),
    name: textOf(value.name, 160, "character name"),
    aliases: stringArray(value.aliases, 20, 160, "character aliases"),
    cueIds: stringArray(value.cueIds, 10_000, 160, "character cue IDs"),
    fingerprint: textOf(value.fingerprint, 64, "character fingerprint"),
    lineFingerprint: textOf(value.lineFingerprint, 64, "character line fingerprint"),
    cueCount: integerOf(value.cueCount, 1_000_000, "cue count"),
    lineCount: integerOf(value.lineCount, 1_000_000, "line count"),
  };
}

function parseManifest(value: unknown): SourceManifest {
  if (!object(value)) throw new Error("The table-read file has no source record.");
  keysOf(value, ["format", "fingerprint", "characters"], "source record");
  if (value.format !== "fdx" && value.format !== "fountain") throw new Error("The table-read file names an unsupported script format.");
  if (!Array.isArray(value.characters) || value.characters.length > 1000) throw new Error("Invalid character list in the table-read file.");
  return {
    format: value.format,
    fingerprint: textOf(value.fingerprint, 64, "source fingerprint"),
    characters: value.characters.map(parseCharacterSource),
  };
}

function parseVoices(value: unknown): Record<string, string> {
  if (!object(value)) return {};
  const out: Record<string, string> = {};
  for (const [engine, voice] of Object.entries(value)) {
    if (!isReadEngine(engine) || typeof voice !== "string" || voice.length > 120 || /[\u0000-\u001f]/.test(voice)) {
      throw new Error("Invalid voice assignment in the table-read file.");
    }
    out[engine] = voice;
  }
  return out;
}

function parseStoredCharacters(value: unknown): StoredCharacter[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Invalid cast in the table-read file.");
  return value.map((raw) => {
    if (!object(raw)) throw new Error("Invalid cast row in the table-read file.");
    keysOf(raw, ["id", "name", "aliases", "cueIds", "locked", "voices"], "cast row");
    if (typeof raw.locked !== "boolean") throw new Error("Invalid cast lock in the table-read file.");
    return {
      id: textOf(raw.id, 160, "character ID"),
      name: textOf(raw.name, 160, "character name"),
      aliases: stringArray(raw.aliases, 20, 160, "character aliases"),
      ...(raw.cueIds === undefined ? {} : { cueIds: stringArray(raw.cueIds, 10_000, 160, "character cue IDs") }),
      locked: raw.locked,
      voices: parseVoices(raw.voices),
    };
  });
}

function parseIgnoredAliases(value: unknown): string[] {
  return stringArray(value, 1000, 400, "confirmed alias list").map((key) => {
    let pair: unknown;
    try { pair = JSON.parse(key); } catch { throw new Error("Invalid confirmed alias in the table-read file."); }
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((part) => typeof part !== "string" || part.length > 400)) {
      throw new Error("Invalid confirmed alias in the table-read file.");
    }
    return key;
  });
}

function parseCastBlock(value: unknown): TableReadSidecar["cast"] {
  if (!object(value)) throw new Error("The table-read file has no cast record.");
  keysOf(value, ["narrator", "characters", "ignoredAliases"], "cast record");
  return {
    narrator: parseVoices(value.narrator),
    characters: parseStoredCharacters(value.characters),
    ignoredAliases: parseIgnoredAliases(value.ignoredAliases),
  };
}

function parseNote(value: unknown): SidecarNote {
  if (!object(value)) throw new Error("Invalid listening note in the table-read file.");
  keysOf(value, ["title", "text", "created", "updated", "anchor", "readSession"], "listening note");
  if (!object(value.anchor)) throw new Error("A listening note has no anchor.");
  keysOf(value.anchor, ["paragraphId", "from", "to", "quote"], "note anchor");
  const from = integerOf(value.anchor.from, 20_000, "note start"),
    to = integerOf(value.anchor.to, 20_000, "note end");
  const note: SidecarNote = {
    title: textOf(value.title, 160, "note title", true),
    text: textOf(value.text, 20_000, "note text", true),
    created: textOf(value.created, 40, "note date"),
    updated: textOf(value.updated, 40, "note date"),
    anchor: {
      paragraphId: textOf(value.anchor.paragraphId, 160, "note paragraph"),
      from: Math.min(from, to), to: Math.max(from, to),
      quote: textOf(value.anchor.quote, 20_000, "note quote", true),
    },
  };
  if (value.readSession !== undefined) {
    if (!object(value.readSession)) throw new Error("Invalid read session on a listening note.");
    keysOf(value.readSession, ["id", "revision", "spokenText"], "read session");
    note.readSession = {
      id: textOf(value.readSession.id, 200, "read session ID"),
      revision: textOf(value.readSession.revision, 200, "read session revision"),
      ...(value.readSession.spokenText !== undefined
        ? { spokenText: textOf(value.readSession.spokenText, 20_000, "spoken text", true) } : {}),
    };
  }
  return note;
}

function parsePronunciationList(value: unknown): Pronunciation[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid pronunciation list in the table-read file.");
  const parsed = parsePronunciations(value);
  if (parsed.length !== value.length) throw new Error("Invalid pronunciation rule in the table-read file.");
  return parsed;
}

/** Strict parse of a sidecar or a bundle's project record. Unknown fields are refused, not ignored. */
export function parseSidecar(value: unknown): TableReadSidecar {
  if (!object(value)) throw new Error("This is not a table-read file.");
  keysOf(value, ["format", "version", "projectId", "created", "updated", "source", "cast", "pronunciations", "notes"], "table-read file");
  if (value.format !== "inklot.table-read") throw new Error("This is not a table-read file.");
  if (value.version !== SIDECAR_VERSION) throw new Error("This table-read file was written by a newer version.");
  if (!Array.isArray(value.notes) || value.notes.length > 400) throw new Error("Invalid listening-note list in the table-read file.");
  return {
    format: "inklot.table-read",
    version: SIDECAR_VERSION,
    projectId: textOf(value.projectId, 64, "project identity"),
    created: textOf(value.created, 40, "creation date"),
    updated: textOf(value.updated, 40, "update date"),
    source: parseManifest(value.source),
    cast: parseCastBlock(value.cast),
    pronunciations: parsePronunciationList(value.pronunciations),
    notes: value.notes.map(parseNote),
  };
}

// ---------- matching ----------

const normalize = (name: string) => name.replace(/\s+/g, " ").trim().toLocaleUpperCase();

function sharesName(stored: CharacterSource, current: CharacterSource): boolean {
  const names = new Set([stored.name, ...stored.aliases].map(normalize));
  return [current.name, ...current.aliases].some((name) => names.has(normalize(name)));
}

/** Compare a stored sidecar with the script in front of the writer. Never writes. */
export function matchSidecar(sidecar: TableReadSidecar, script: Script, format: SidecarFormat): SidecarMatch {
  const identities: CharacterIdentity[] = sidecar.source.characters.map((character) => ({
    id: character.id,
    displayName: character.name,
    aliases: [...character.aliases],
    cueIds: sidecar.source.format === "fdx" ? [...character.cueIds] : [],
  }));
  const current = buildSourceManifest(script, format, identities);
  const currentById = new Map(current.characters.map((row) => [row.id, row]));
  const used = new Set<string>();
  const pairs: CharacterMatch[] = [];

  for (const stored of sidecar.source.characters) {
    let row = currentById.get(stored.id);
    if (row && used.has(row.id)) row = undefined;
    let strength: CharacterMatch["strength"] = "changed", strong = false, reason = "";
    const idAlive = !!row && stored.cueIds.length > 0 && currentById.get(stored.id)!.cueIds.some((id) => stored.cueIds.includes(id));
    if (row && idAlive) {
      strong = true;
      if (stored.fingerprint === row.fingerprint) { strength = "exact"; reason = "Same cue paragraph, unchanged dialogue."; }
      else reason = "Same cue paragraph, but its text changed.";
    } else if (row && sharesName(stored, row)) {
      if (stored.fingerprint === row.fingerprint) { strength = "exact"; strong = true; reason = "Same name, unchanged dialogue."; }
      else reason = "Same name, but the dialogue changed.";
    } else {
      row = current.characters.find((candidate) => !used.has(candidate.id) && sharesName(stored, candidate));
      if (row) {
        if (stored.fingerprint === row.fingerprint) { strength = "exact"; strong = true; reason = "Same name, unchanged dialogue."; }
        else reason = "Same name, but the dialogue changed.";
      }
    }
    if (!row && stored.lineCount > 0) {
      const matches = current.characters.filter((candidate) =>
        !used.has(candidate.id) && candidate.lineCount > 0 && candidate.lineFingerprint === stored.lineFingerprint);
      if (matches.length === 1) {
        row = matches[0]!;
        strength = "inferred"; strong = true;
        reason = "The name changed, but the dialogue is unchanged.";
      }
    }
    if (row) used.add(row.id);
    pairs.push({
      storedId: stored.id, storedName: stored.name,
      currentId: row?.id ?? null, currentName: row?.name ?? null,
      strength, strong, reason: row ? reason : "This character is no longer in the script.",
    });
  }

  let kind: SidecarMatch["kind"];
  if (!sidecar.source.characters.length) {
    kind = sidecar.source.fingerprint === current.fingerprint ? "exact" : "mismatch";
  } else if (!pairs.some((pair) => pair.currentId && pair.strong)) {
    kind = "mismatch";
  } else if (pairs.every((pair) => pair.currentId && pair.strength === "exact" && pair.strong)) {
    kind = "exact";
  } else {
    kind = "partial";
  }
  const message = kind === "exact"
    ? "The table-read file belongs to this script."
    : kind === "partial"
      ? "Some characters changed. Review which cast row belongs to which character before attaching."
      : "This table-read file belongs to a different script. Nothing is attached.";
  return {
    kind, pairs, message,
    current: current.characters.map((row) => ({ id: row.id, name: row.name })),
  };
}

export function reviewedMatch(match: SidecarMatch, choices: Readonly<Record<string, string>>): SidecarMatch {
  const current = new Map(match.current.map((row) => [row.id, row.name]));
  const pairs = match.pairs.map((pair) => {
    const id = choices[pair.storedId];
    return { ...pair, currentId: id && current.has(id) ? id : null, currentName: current.get(id ?? "") ?? null };
  });
  return { ...match, pairs };
}

// ---------- applying ----------

/** Two stored characters cannot share one script character: one voice and lock would silently win. */
export function duplicateDestination(match: SidecarMatch): string | null {
  const seen = new Map<string, string>();
  for (const pair of match.pairs) {
    if (!pair.currentId) continue;
    const first = seen.get(pair.currentId);
    if (first !== undefined) {
      return `${first} and ${pair.storedName} are both attached to ${pair.currentName ?? "the same character"}. `
        + "Choose a different character for one of them, or don't attach it.";
    }
    seen.set(pair.currentId, pair.storedName);
  }
  return null;
}

/** Find a listening note's passage after a reopen: its paragraph ID first, then a unique quote anywhere. */
export function noteAnchorIn(doc: ScreenplayDoc, note: SidecarNote): { paragraphId: string; from: number; to: number } | null {
  const quote = note.anchor.quote;
  const locate = (id: string): { paragraphId: string; from: number; to: number } | null => {
    if (!doc.has(id)) return null;
    const text = plainText(doc.paragraph(id).runs);
    if (!quote) return { paragraphId: id, from: 0, to: 0 };
    const at = text.indexOf(quote);
    if (at < 0 || text.indexOf(quote, at + 1) >= 0) return null;
    return { paragraphId: id, from: at, to: at + quote.length };
  };
  const direct = locate(note.anchor.paragraphId);
  if (direct) return direct;
  if (!quote) return null;
  const hits: { paragraphId: string; from: number; to: number }[] = [];
  for (const paragraph of doc.paragraphs()) {
    const text = plainText(paragraph.runs), at = text.indexOf(quote);
    if (at < 0) continue;
    if (text.indexOf(quote, at + 1) >= 0) return null;
    hits.push({ paragraphId: paragraph.id, from: at, to: at + quote.length });
  }
  return hits.length === 1 ? hits[0]! : null;
}

function namesMatch(a: { name: string; aliases: readonly string[] }, b: { name: string; aliases: readonly string[] }): boolean {
  const names = new Set([a.name, ...a.aliases].map(normalize));
  return [b.name, ...b.aliases].some((name) => names.has(normalize(name)));
}

function remapIgnored(key: string, resolve: (id: string) => string | null): string | null {
  try {
    const pair: unknown = JSON.parse(key);
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((part) => typeof part !== "string")) return null;
    const id = resolve(pair[0] as string);
    return id ? JSON.stringify([id, pair[1]]) : null;
  } catch {
    return null;
  }
}

/**
 * Attach a matched sidecar. `confirmed` limits character rows to the writer's reviewed choices; narrator,
 * pronunciations and listening notes belong to the project as a whole. A read-only session is
 * refused before anything is touched. `voiceRemap` follows imported reference voices to their local IDs.
 */
export function applySidecar(
  session: DocumentSession, sidecar: TableReadSidecar, match: SidecarMatch,
  confirmed?: ReadonlySet<string>, voiceRemap: Readonly<Record<string, string>> = {},
): ApplyResult {
  const result: ApplyResult = { applied: false, characters: 0, pronunciations: 0, notes: 0, detachedNotes: 0 };
  if (session.readOnly) return { ...result, reason: "This script is read-only." };
  const pairsById = new Map(match.pairs.map((pair) => [pair.storedId, pair]));
  // A sidecar normally uses one ID for a source character and its cast row. Older or hand-edited files may not,
  // so a row without a direct pair is matched to its source character by name before it is discarded.
  const resolved = new Map<string, { sourceId: string; currentId: string }>();
  for (const stored of sidecar.cast.characters) {
    const source = sidecar.source.characters.find((row) => row.id === stored.id)
      ?? sidecar.source.characters.find((row) => namesMatch(row, stored));
    if (!source || (confirmed && !confirmed.has(source.id))) continue;
    const pair = pairsById.get(source.id);
    if (pair?.currentId) resolved.set(stored.id, { sourceId: source.id, currentId: pair.currentId });
  }
  const claimed = new Map<string, string>();
  for (const [storedId, entry] of resolved) {
    const first = claimed.get(entry.currentId);
    if (first !== undefined) {
      const name = (id: string) => sidecar.cast.characters.find((row) => row.id === id)?.name ?? id;
      return { ...result, reason: `${name(first)} and ${name(storedId)} are both attached to `
        + `${match.current.find((row) => row.id === entry.currentId)?.name ?? "the same character"}. `
        + "Choose a different character for one of them, or don't attach it." };
    }
    claimed.set(entry.currentId, storedId);
  }
  const currentNames = new Map(match.current.map((row) => [row.id, row.name]));
  const existingCast = new Map(readStoredCast(session.doc).characters.map((row) => [row.id, row]));
  const currentCharacters = buildCharacterRegistry(session.script(), match.current.map((row) => ({
    id: row.id, displayName: row.name, aliases: [], cueIds: [],
  }))).characters;
  const currentCueIds = new Map(currentCharacters.map((row) => [row.id, row.cueIds]));
  const seen = new Set<string>();
  const rows: StoredCharacter[] = [];
  for (const stored of sidecar.cast.characters) {
    const mapped = resolved.get(stored.id);
    if (!mapped || seen.has(mapped.currentId)) continue;
    seen.add(mapped.currentId);
    const currentName = currentNames.get(mapped.currentId) ?? stored.name;
    const existing = existingCast.get(mapped.currentId);
    const voices = Object.fromEntries(
      Object.entries(stored.voices).map(([engine, voice]) => [engine, voiceRemap[voice] ?? voice]),
    );
    // A lock is the writer's decision. An import fills gaps but never silently unlocks or recasts an existing row.
    if (existing?.locked) for (const [engine, voice] of Object.entries(existing.voices)) voices[engine] = voice;
    rows.push({
      id: mapped.currentId,
      name: currentName,
      cueIds: currentCueIds.get(mapped.currentId) ?? [],
      aliases: [...new Set([...stored.aliases, stored.name]
        .map((name) => name.trim()).filter((name) => name && name !== currentName))].slice(0, 20),
      locked: stored.locked || existing?.locked === true,
      voices,
    });
  }
  const currentIds = new Set(match.current.map((row) => row.id));
  const sourceToCurrent = new Map([...resolved.values()].map((entry) => [entry.sourceId, entry.currentId]));
  const resolveId = (id: string): string | null =>
    resolved.get(id)?.currentId ?? sourceToCurrent.get(id) ?? (currentIds.has(id) ? id : null);
  const ignoredAliases = sidecar.cast.ignoredAliases
    .map((key) => remapIgnored(key, resolveId))
    .filter((key): key is string => key !== null);

  session.undo.stopCapturing();
  writeCast(session, {
    narrator: Object.fromEntries(Object.entries(sidecar.cast.narrator)
      .map(([engine, voice]) => [engine, voiceRemap[voice] ?? voice])),
    characters: rows,
    ignoredAliases,
  });
  result.applied = true;
  result.characters = rows.length;
  if (sidecar.pronunciations.length) {
    session.edit(() => session.doc.meta.set(PRONUNCIATION_KEY, sidecar.pronunciations.map((rule) => ({ ...rule }))));
    result.pronunciations = sidecar.pronunciations.length;
  }
  for (const note of sidecar.notes) {
    const anchor = noteAnchorIn(session.doc, note);
    if (!anchor) result.detachedNotes++;
    const extra = {
      anchor: anchor ? anchorAt(session.doc, { paragraphId: anchor.paragraphId, offset: anchor.from },
        { paragraphId: anchor.paragraphId, offset: anchor.to }) : { ...note.anchor, start: [], end: [] },
      readSession: { ...note.readSession },
    };
    session.edit(() => putRecord(session.doc, {
      ...createRecord("note", note.title, note.text, extra), created: note.created,
    }));
    result.notes++;
  }
  session.undo.stopCapturing();
  return result;
}
