// Stable character identities across renames, cue extensions and reviewed aliases, plus bounded evidence
// for casting. Nothing here merges two names on its own: alias detection only suggests, and the writer
// confirms. A language model never sees more of the script than the packets built here.
import { type Paragraph, type Script, NON_PRINTING, scenesOf } from "./model.ts";
import { characterName, countWords, findMentions } from "./reports.ts";

/** The narrator is a distinct identity outside the story cast, never a character row. */
export const NARRATOR = "@narrator";

export interface CharacterIdentity {
  /** Durable ID, which survives a rename: the paragraph ID of the first cue no other character's ID already uses. */
  id: string;
  /** Normalized name as the cues spell it now. */
  displayName: string;
  /** Other normalized names confirmed to be this character. */
  aliases: string[];
  /** Paragraph IDs of every cue for this character. */
  cueIds: string[];
}

export interface AliasSuggestion {
  /** The identity that would keep its name and voice. */
  characterId: string;
  /** The identity that would become an alias. */
  aliasCharacterId: string;
  /** The other name that would become an alias. */
  name: string;
  reason: string;
}

export interface CharacterRegistry {
  narrator: CharacterIdentity;
  characters: CharacterIdentity[];
  suggestions: AliasSuggestion[];
}

export const NARRATOR_IDENTITY: CharacterIdentity = { id: NARRATOR, displayName: "Narrator", aliases: [], cueIds: [] };

/** Cue text reduced to the name a reader would speak: no (V.O.), CONT'D or stray quotes. */
export function normalizeCharacterName(name: string): string {
  return characterName(name).replace(/\s+/g, " ").trim();
}

const TITLES = new Set(["MR", "MRS", "MS", "MISS", "DR", "DOCTOR", "PROF", "PROFESSOR", "REV", "FR", "SGT", "LT", "CPT", "CAPT", "COL", "GEN", "ST"]);

function bareWords(name: string): string[] {
  const words = normalizeCharacterName(name).split(" ").filter(Boolean);
  while (words.length > 1 && TITLES.has(words[0]!)) words.shift();
  return words;
}

const endsWith = (words: readonly string[], tail: readonly string[]) =>
  tail.length < words.length && words.slice(-tail.length).every((word, i) => word === tail[i]);

const startsWith = (words: readonly string[], head: readonly string[]) =>
  head.length < words.length && words.slice(0, head.length).every((word, i) => word === head[i]);

/** Why one name might be the same person as another, or null. Only a suggestion: never a merge. */
function aliasReason(first: string, second: string): string | null {
  const a = bareWords(first), b = bareWords(second);
  if (!a.length || !b.length) return null;
  if (a.join(" ") === b.join(" ")) return `${first} and ${second} differ only by a title.`;
  if (endsWith(a, b) && b.join("").length >= 3) return `${first} ends with ${second}.`;
  if (endsWith(b, a) && a.join("").length >= 3) return `${second} ends with ${first}.`;
  if (startsWith(a, b) && b.join("").length >= 3) return `${first} starts with ${second}.`;
  if (startsWith(b, a) && a.join("").length >= 3) return `${second} starts with ${first}.`;
  return null;
}

function cloneIdentity(identity: CharacterIdentity): CharacterIdentity {
  return { id: identity.id, displayName: identity.displayName, aliases: [...identity.aliases], cueIds: [...identity.cueIds] };
}

/** Paragraph text without inline notes, as the reader hears it. */
function spoken(paragraph: Paragraph): string {
  return paragraph.runs.filter((run) => !run.note).map((run) => run.text).join("");
}

/**
 * Group the script's cues into durable identities. Stored identities are trusted as given: their aliases
 * are confirmed merges, so a cue under an alias joins that character. Without stored aliases every name is
 * its own character.
 *
 * A stored character is renamed only when none of its saved cues still carries its name or an alias, and
 * then only to a name no stored character owns (the most common one on its cues). The Rename Character command
 * does not rely on this: it saves the new name with the cast. The old name becomes
 * an alias so exports and older cast files still resolve, and the character keeps its ID and voice. Any other
 * cue goes by the name it carries now: retyping one of ALICE's cues as BOB moves that line to BOB and leaves
 * ALICE as she was. A new character takes the ID of its first cue unless a character already has that ID.
 */
export function buildCharacterRegistry(script: Script, stored: readonly CharacterIdentity[] = []): CharacterRegistry {
  const confirmed = stored.slice(0, 1000).map(cloneIdentity);
  const byName = new Map<string, CharacterIdentity>();
  // A cast saved one row at a time can list a moved cue under its old character and its new one.
  const byCue = new Map<string, CharacterIdentity[]>();
  for (const identity of confirmed) {
    const name = normalizeCharacterName(identity.displayName);
    identity.displayName = name;
    identity.aliases = identity.aliases.map(normalizeCharacterName).filter((alias) => alias && alias !== name);
    if (!name) continue;
    byName.set(name, identity);
    for (const alias of identity.aliases) if (!byName.has(alias)) byName.set(alias, identity);
    for (const cueId of identity.cueIds) byCue.set(cueId, [...byCue.get(cueId) ?? [], identity]);
    // Rebuilt in script order below; a stored order says nothing about this revision.
    identity.cueIds = [];
  }

  const cues: { id: string; name: string }[] = [];
  for (const paragraph of script.paragraphs) {
    if (paragraph.type === "character") cues.push({ id: paragraph.id, name: normalizeCharacterName(spoken(paragraph)) });
  }
  const owns = (identity: CharacterIdentity, name: string) => identity.displayName === name || identity.aliases.includes(name);

  // Pass 1: a stored character whose saved cues all carry one new name was renamed (Rename Character). A name
  // another stored character owns means the lines moved to that character instead, so nothing is renamed.
  const surviving = new Map<CharacterIdentity, { name: string; shared: boolean }[]>();
  for (const cue of cues) {
    const listers = cue.name ? byCue.get(cue.id) ?? [] : [];
    for (const owner of listers) surviving.set(owner, [...surviving.get(owner) ?? [], { name: cue.name, shared: listers.length > 1 }]);
  }
  // A cue two characters list is weak evidence, because one of the rows is a stale listing of a line that moved.
  // A character's new name is the most common free name on its cues. Renames are granted one at a time, first
  // to a character with a cue of its own under its pick, because each grant takes a name out of play and can
  // change what the others would pick.
  const owned = new Set(confirmed.flatMap((identity) => [identity.displayName, ...identity.aliases]));
  const pending = new Map([...surviving].filter(([identity, found]) => !found.some((cue) => owns(identity, cue.name))));
  const pick = (found: { name: string; shared: boolean }[]) => {
    const counts = new Map<string, number>(), solo = new Set<string>();
    for (const cue of found) {
      if (owned.has(cue.name)) continue;
      counts.set(cue.name, (counts.get(cue.name) ?? 0) + 1);
      if (!cue.shared) solo.add(cue.name);
    }
    // A tie goes to a name on a cue of the character's own, then to the name that comes first in the script
    // (map order is first appearance).
    const rank = (name: string) => counts.get(name)! * 2 + Number(solo.has(name));
    let name: string | undefined;
    for (const other of counts.keys()) if (!name || rank(other) > rank(name)) name = other;
    return name ? { name, own: solo.has(name) } : undefined;
  };
  for (;;) {
    let grant: [CharacterIdentity, string] | undefined;
    for (const own of [true, false]) {
      for (const [identity, found] of pending) {
        const choice = pick(found);
        // Names are only ever taken, so a character with none left to pick is done.
        if (!choice) pending.delete(identity);
        else if (choice.own || !own) { grant = [identity, choice.name]; break; }
      }
      if (grant) break;
    }
    if (!grant) break;
    const [identity, renamed] = grant;
    pending.delete(identity);
    if (!identity.aliases.includes(identity.displayName)) identity.aliases.push(identity.displayName);
    identity.displayName = renamed;
    byName.set(renamed, identity);
    owned.add(renamed);
  }

  // Pass 2: a saved cue stays with its character while it carries that character's name; every other cue goes by name.
  const characters: CharacterIdentity[] = [];
  const seen = new Set<CharacterIdentity>();
  const created: CharacterIdentity[] = [];
  let current: CharacterIdentity | undefined;
  let next = 0;
  for (const paragraph of script.paragraphs) {
    if (paragraph.type === "character") {
      const { name } = cues[next++]!;
      if (!name) { current = undefined; continue; }
      current = byCue.get(paragraph.id)?.find((owner) => owns(owner, name)) ?? byName.get(name);
      if (!current) {
        current = { id: "", displayName: name, aliases: [], cueIds: [] };
        byName.set(name, current);
        created.push(current);
      }
      if (!current.cueIds.includes(paragraph.id)) current.cueIds.push(paragraph.id);
      if (!seen.has(current)) { seen.add(current); characters.push(current); }
    } else if (paragraph.type !== "parenthetical" && !NON_PRINTING.has(paragraph.type)) {
      current = undefined;
    }
  }

  // Two characters with one ID would share a voice and merge their lines, so a new character skips any cue ID
  // a character already uses, and falls back to a numbered ID when all of its cue IDs are taken.
  const taken = new Set(confirmed.map((identity) => identity.id));
  for (const identity of created) {
    let id = identity.cueIds.find((cueId) => !taken.has(cueId));
    for (let n = 2; !id; n++) if (!taken.has(`${identity.cueIds[0]}~${n}`)) id = `${identity.cueIds[0]}~${n}`;
    identity.id = id;
    taken.add(id);
  }

  const suggestions: AliasSuggestion[] = [];
  for (let i = 0; i < characters.length; i++) {
    for (let j = i + 1; j < characters.length; j++) {
      const target = characters[i]!, other = characters[j]!;
      const reason = aliasReason(target.displayName, other.displayName);
      if (reason && !target.aliases.includes(other.displayName) && !other.aliases.includes(target.displayName)) {
        suggestions.push({ characterId: target.id, aliasCharacterId: other.id, name: other.displayName, reason });
      }
    }
  }
  return { narrator: { ...NARRATOR_IDENTITY }, characters, suggestions };
}

/** Fold one identity into another after the writer confirms they are the same person. */
export function mergeIdentities(characters: readonly CharacterIdentity[], fromId: string, intoId: string): CharacterIdentity[] {
  if (fromId === intoId) return characters.map(cloneIdentity);
  const from = characters.find((c) => c.id === fromId), into = characters.find((c) => c.id === intoId);
  if (!from || !into) throw new Error("That character is no longer in the script.");
  const merged: CharacterIdentity = {
    id: into.id,
    displayName: into.displayName,
    aliases: [...new Set([...into.aliases, from.displayName, ...from.aliases].filter((name) => name && name !== into.displayName))],
    cueIds: [...into.cueIds, ...from.cueIds],
  };
  return characters.filter((c) => c.id !== fromId).map((c) => (c.id === intoId ? merged : cloneIdentity(c)));
}

/** Every cue name that maps to an identity, for voice lookups that receive only the script's speaker name. */
export function aliasTable(characters: readonly CharacterIdentity[]): Map<string, string> {
  const table = new Map<string, string>();
  for (const character of characters) {
    table.set(character.displayName, character.id);
    for (const alias of character.aliases) table.set(alias, character.id);
  }
  return table;
}

// ---------- evidence packets ----------

export interface EvidenceOptions {
  maxLines?: number;
  maxLineChars?: number;
  maxDescriptions?: number;
  maxDescriptionChars?: number;
  maxParentheticals?: number;
  /** Cap on the packet's evidence text, not counting IDs. */
  maxChars?: number;
}

export const DEFAULT_EVIDENCE: Required<EvidenceOptions> = {
  maxLines: 4, maxLineChars: 220, maxDescriptions: 3, maxDescriptionChars: 260, maxParentheticals: 2, maxChars: 1400,
};

export interface EvidenceLine {
  paragraphId: string;
  sceneId: string | null;
  text: string;
}

export interface EvidencePacket {
  characterId: string;
  name: string;
  /** Changes when any speech or description of this character changes. */
  fingerprint: string;
  lineCount: number;
  wordCount: number;
  sceneCount: number;
  sceneIds: string[];
  /** Sample speeches spread across the whole script, not the nearest scenes. */
  lines: EvidenceLine[];
  /** Action lines where the character is named, which is how the script describes them. */
  descriptions: { paragraphId: string; text: string }[];
  parentheticals: { paragraphId: string; text: string }[];
  /** Paragraph IDs a proposal may cite. */
  anchors: string[];
  truncated: boolean;
}

/** FNV-1a, hex. Stable across runs and cheap enough to run on every script change. */
export function fingerprintOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function trimText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Evenly spaced picks, so a sample covers the beginning, middle and end of a long script. */
function spread<T>(items: readonly T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (items.length <= count) return [...items];
  if (count === 1) return [items[0]!];
  const picked: T[] = [];
  for (let i = 0; i < count; i++) picked.push(items[Math.floor((i * (items.length - 1)) / (count - 1))]!);
  return picked;
}

/**
 * Everything a casting request may know about one character: how much they speak, where, a few lines from
 * across the script, the action lines that describe them and their parentheticals. Bounded in both count
 * and length; paragraph IDs travel with the evidence so a proposal can cite it.
 */
export function characterEvidence(script: Script, identity: CharacterIdentity, options: EvidenceOptions = {}): EvidencePacket {
  const limits = { ...DEFAULT_EVIDENCE, ...options };
  const scenes = scenesOf(script.paragraphs);
  const sceneOf = new Map<string, string>();
  for (const scene of scenes) for (const id of scene.paragraphIds) sceneOf.set(id, scene.sceneId);
  const cueIds = new Set(identity.cueIds);

  const lines: EvidenceLine[] = [];
  const allParentheticals: { paragraphId: string; text: string }[] = [];
  const descriptions: { paragraphId: string; text: string }[] = [];
  const names = [...new Set([
    identity.displayName, ...identity.aliases, bareWords(identity.displayName).join(" "),
    ...identity.aliases.map((alias) => bareWords(alias).join(" ")),
  ])].filter((name) => name.length >= 2);
  let inSpeech = false;

  for (const paragraph of script.paragraphs) {
    if (paragraph.type === "character") {
      inSpeech = cueIds.has(paragraph.id) || (cueIds.size === 0 && normalizeCharacterName(spoken(paragraph)) === identity.displayName);
      continue;
    }
    if (paragraph.type === "dialogue" || paragraph.type === "lyrics") {
      if (!inSpeech) continue;
      const text = spoken(paragraph).trim();
      if (text) lines.push({ paragraphId: paragraph.id, sceneId: sceneOf.get(paragraph.id) ?? null, text });
      continue;
    }
    if (paragraph.type === "parenthetical") {
      if (inSpeech) {
        const text = spoken(paragraph).trim();
        if (text) allParentheticals.push({ paragraphId: paragraph.id, text });
      }
      continue;
    }
    if (!NON_PRINTING.has(paragraph.type)) inSpeech = false;
    if (!["action", "general", "shot"].includes(paragraph.type)) continue;
    const text = spoken(paragraph).trim();
    if (!text) continue;
    if (names.some((name) => findMentions(text, name).length)) descriptions.push({ paragraphId: paragraph.id, text });
  }

  const sceneIds = [...new Set(lines.map((line) => line.sceneId).filter((id): id is string => !!id))];
  const sampledLines = spread(lines, limits.maxLines).map((line) => ({ ...line, text: trimText(line.text, limits.maxLineChars) }));
  const sampledDescriptions = spread(descriptions, limits.maxDescriptions).map((row) => ({ ...row, text: trimText(row.text, limits.maxDescriptionChars) }));
  const sampledParentheticals = spread(allParentheticals, limits.maxParentheticals).map((row) => ({ ...row, text: trimText(row.text, 80) }));

  const evidenceLength = (packet: Pick<EvidencePacket, "lines" | "descriptions" | "parentheticals">) =>
    packet.lines.reduce((sum, line) => sum + line.text.length, 0)
    + packet.descriptions.reduce((sum, row) => sum + row.text.length, 0)
    + packet.parentheticals.reduce((sum, row) => sum + row.text.length, 0);

  let truncated = sampledLines.length < lines.length || sampledDescriptions.length < descriptions.length;
  const packet = { lines: sampledLines, descriptions: sampledDescriptions, parentheticals: sampledParentheticals };
  // Drop whole samples from the end, then shorten the longest remaining citation until the packet fits.
  while (evidenceLength(packet) > limits.maxChars && (packet.descriptions.length > 1 || packet.lines.length > 1 || packet.parentheticals.length > 0)) {
    if (packet.parentheticals.length) packet.parentheticals.pop();
    else if (packet.descriptions.length > 1) packet.descriptions.pop();
    else packet.lines.pop();
    truncated = true;
  }
  const texts = [...packet.lines, ...packet.descriptions, ...packet.parentheticals];
  while (evidenceLength(packet) > limits.maxChars) {
    const longest = texts.reduce<{ text: string } | undefined>((best, row) => (!best || row.text.length > best.text.length ? row : best), undefined);
    if (!longest || longest.text.length <= 1) break;
    const over = evidenceLength(packet) - limits.maxChars;
    longest.text = longest.text.slice(0, Math.max(1, longest.text.length - over));
    truncated = true;
  }

  const source = [
    identity.displayName, ...identity.aliases,
    ...lines.map((line) => `${line.paragraphId}\u0001${line.text}`),
    ...allParentheticals.map((row) => `${row.paragraphId}\u0001${row.text}`),
    ...descriptions.map((row) => `${row.paragraphId}\u0001${row.text}`),
  ].join("\u0002");

  return {
    characterId: identity.id,
    name: identity.displayName,
    fingerprint: fingerprintOf(source),
    lineCount: lines.length,
    wordCount: lines.reduce((sum, line) => sum + countWords(line.text), 0),
    sceneCount: sceneIds.length,
    sceneIds,
    lines: packet.lines,
    descriptions: packet.descriptions,
    parentheticals: packet.parentheticals,
    anchors: [...new Set([...packet.lines.map((line) => line.paragraphId), ...packet.descriptions.map((row) => row.paragraphId), ...packet.parentheticals.map((row) => row.paragraphId)])],
    truncated,
  };
}

/** Packets keyed by character ID. An unchanged fingerprint reuses the previous packet object. */
export class EvidenceCache {
  private readonly entries = new Map<string, EvidencePacket>();

  build(script: Script, identities: readonly CharacterIdentity[], options?: EvidenceOptions): { packets: EvidencePacket[]; reused: string[] } {
    const packets: EvidencePacket[] = [], reused: string[] = [];
    for (const identity of identities) {
      const next = characterEvidence(script, identity, options);
      const previous = this.entries.get(identity.id);
      if (previous && previous.fingerprint === next.fingerprint) {
        packets.push(previous);
        reused.push(identity.id);
      } else {
        this.entries.set(identity.id, next);
        packets.push(next);
      }
    }
    return { packets, reused };
  }

  clear(): void {
    this.entries.clear();
  }
}
