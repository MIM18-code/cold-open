// Deterministic ensemble casting. Voices are matched to the character evidence (a first name only settles gender
// when the script is silent), and characters who share scenes are pushed apart. The narrator's voice is reserved for minor roles. Nothing
// here writes: locked roles are returned untouched, and "recast this character" changes one key only.
import type { EvidencePacket } from "@screenplay/engine";
import type { ReadVoice } from "../../../shared/channels/table-read.ts";
import { nameGender } from "./first-names.ts";

/**
 * The models agent will fill `tags` with curated descriptive words (gender presentation, age range,
 * accent, timbre). Until the catalogue lands every voice carries only its language as a tag.
 */
export interface VoiceInfo { id: string; engine: string; name: string; tags: string[]; }

export interface CastSubject {
  id: string;
  name: string;
  lineCount: number;
  sceneIds: string[];
  /** Action descriptions, parentheticals and sample lines, used only for explicit vocal words. */
  evidence: string;
  /** How the script presents the character, when it says so plainly. */
  gender?: Gender;
}

export type Gender = "female" | "male";
const PERSON = /\b(?:a|an|the|another|some|one)\s+(?:[a-z-]+\s+)?(?:man|woman|boy|girl|guy|lady|stranger|kid|child|person|figure|teen|teenager|officer|cop|nurse|doctor|driver|waiter|waitress|soldier|guard|rider)\b/i;
const FEMALE_ROLE = /\b(?:MOTHER|MOM|MOMMY|MOMMA|MAMA|SISTER|GIRL|WOMAN|LADY|WIFE|AUNT|AUNTIE|GRANDMA|GRANDMOTHER|NANA|GRANNY|QUEEN|PRINCESS|MRS|MS|MISS|DAUGHTER|NIECE|BRIDE|GIRLFRIEND|WAITRESS|ACTRESS|NUN|MADAM|MADAME)\b/;
const MALE_ROLE = /\b(?:FATHER|DAD|DADDY|PAPA|BROTHER|BOY|MAN|GUY|HUSBAND|UNCLE|GRANDPA|GRANDFATHER|KING|PRINCE|MR|SIR|SON|NEPHEW|GROOM|BOYFRIEND|WAITER|PRIEST|MONK|LORD)\b/;

/**
 * A role word in the name (MOTHER, BROTHER, MRS. KIM) decides, unless the action lines plainly say otherwise. Without
 * one, the pronouns in the action lines that name the character decide when one side clearly outnumbers the other.
 * Pronouns count only in sentences where this character is the one in view: a sentence that names other characters,
 * and the sentences after it until someone is named again, are skipped, and a possessive ("Jerry's") is not the
 * character in view. Dialogue is left out: characters talk about other people.
 */
export function characterGender(name: string, descriptions: readonly string[], others: readonly string[] = [], aliases: readonly string[] = []): Gender | undefined {
  return reading(name, descriptions, others, aliases).gender;
}

/** The decision plus the in-view pronoun counts behind it, so a first name is not used against them. */
function reading(name: string, descriptions: readonly string[], others: readonly string[], aliases: readonly string[]): { gender?: Gender; she: number; he: number } {
  const words = (n: string) => n.replace(/\s*\(.*?\)/g, "").trim().toLowerCase();
  const own = words(name), self = new Set([own, ...aliases.map(words)].filter(Boolean)), rest = [...new Set(others.map(words))].filter((n) => n && !self.has(n));
  const escaped = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "MAYA, a woman," or "MAYA (17), a girl who..." says it outright.
  for (const description of descriptions) for (const n of self) {
    const told = new RegExp(`(?<!\\p{L})${escaped(n)}(?!\\p{L})\\s*(?:\\([^)]*\\))?\\s*,\\s*an?\\s+(?:[\\p{L}-]+\\s+)?(woman|girl|lady|man|boy|guy)(?!['’\\p{L}])`, "iu").exec(description)?.[1]?.toLowerCase();
    if (told) return { gender: told === "woman" || told === "girl" || told === "lady" ? "female" : "male", she: 0, he: 0 };
  }
  const named = (sentence: string, n: string) =>
    new RegExp(`(?:^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!['’]s\\b)(?:$|[^\\p{L}])`, "iu").test(sentence);
  let she = 0, he = 0;
  for (const description of descriptions) {
    let inView: string[] = [];
    for (const sentence of description.split(/(?<=[.!?])\s+/)) {
      // Someone unnamed ("a man", "the woman") is another person in view too.
      const mentioned = [...[...self].some((n) => named(sentence, n)) ? [own] : [], ...rest.filter((n) => named(sentence, n)),
        ...(PERSON.test([...self, ...rest].reduce((text, n) => text.replace(new RegExp(`(?<!\\p{L})${escaped(n)}(?!\\p{L})`, "giu"), " "), sentence)) ? ["?"] : [])];
      if (mentioned.length) inView = mentioned;
      if (inView.length !== 1 || inView[0] !== own) continue;
      she += sentence.match(/\b(?:she|her|hers|herself)\b/gi)?.length ?? 0;
      he += sentence.match(/\b(?:he|him|his|himself)\b/gi)?.length ?? 0;
    }
  }
  const upper = name.toUpperCase(), female = FEMALE_ROLE.test(upper), male = MALE_ROLE.test(upper);
  if (female !== male) {
    const against = female ? he : she, matching = female ? she : he;
    if (against >= 3 && !matching) return { gender: female ? "male" : "female", she, he };
    // Some contrary evidence without enough to overrule the name: say nothing rather than guess.
    if (against >= 2 && against > matching) return { she, he };
    return { gender: female ? "female" : "male", she, he };
  }
  if (she >= 2 && she >= 2 * he) return { gender: "female", she, he };
  if (he >= 2 && he >= 2 * she) return { gender: "male", she, he };
  return { she, he };
}

/**
 * What the script says, then the conventional gender of the first name, but only when no pronoun about the
 * character points the other way ("MAYA waits. He smiles." stays open for the model to read).
 */
export function scriptGender(name: string, descriptions: readonly string[], others: readonly string[] = [], aliases: readonly string[] = []): Gender | undefined {
  const found = reading(name, descriptions, others, aliases);
  if (found.gender) return found.gender;
  const guess = nameGender(name, aliases);
  const against = guess === "female" ? found.he : found.she, matching = guess === "female" ? found.she : found.he;
  return guess && against <= matching ? guess : undefined;
}

export function subjectFromPacket(packet: EvidencePacket, others: readonly string[] = [], aliases: readonly string[] = []): CastSubject {
  return {
    id: packet.characterId,
    name: packet.name,
    lineCount: packet.lineCount,
    sceneIds: packet.sceneIds,
    evidence: [...packet.descriptions.map((row) => row.text), ...packet.parentheticals.map((row) => row.text), ...packet.lines.map((line) => line.text)].join(" "),
    ...(() => { const gender = scriptGender(packet.name, packet.descriptions.map((row) => row.text), others, aliases); return gender ? { gender } : {}; })(),
  };
}

export function voiceInfos(voices: readonly ReadVoice[], engine: string): VoiceInfo[] {
  return voices.map((voice) => {
    const language = voice.language.toLowerCase();
    const tags = [language];
    if (language === "en-us") tags.push("american");
    else if (language === "en-gb") tags.push("british");
    else if (language === "en-au") tags.push("australian");
    else if (language === "en-ie") tags.push("irish");
    else if (language === "en-in") tags.push("indian");
    else if (language === "en-ca") tags.push("canadian");
    else if (language === "en-nz") tags.push("new zealand");
    else if (language === "en-za") tags.push("south african");
    for (const tag of voice.tags ?? []) if (tag === "female" || tag === "male") tags.push(tag);
    return { id: voice.id, engine, name: voice.label, tags };
  });
}

export interface EnsembleInput {
  subjects: readonly CastSubject[];
  voices: readonly VoiceInfo[];
  /** The narrator's current voice, kept away from characters with substantial dialogue. */
  narratorVoice?: string;
  /** Character ID to voice ID. Locked roles are returned unchanged. */
  locked?: Readonly<Record<string, string>>;
  /** A role with at least this many speeches is major; the default is relative to the largest role. */
  majorLineCount?: number;
}

const ACCENTS = [
  "british", "american", "irish", "scottish", "welsh", "australian", "southern", "new zealand",
  "south african", "french", "german", "spanish", "italian", "russian", "indian", "canadian", "cockney", "yorkshire",
];
const STOP = new Set([
  "voice", "voices", "with", "this", "that", "from", "have", "your", "their", "female", "male", "woman", "man",
  "young", "adult", "older", "middle", "aged", "neutral", "english", "language", "warm", "light", "dark",
]);

function tagWords(voice: VoiceInfo): Set<string> {
  const words = new Set<string>();
  for (const tag of voice.tags) for (const word of tag.toLowerCase().split(/[^a-z]+/)) if (word.length > 3 && !STOP.has(word)) words.add(word);
  return words;
}

/** Explicit vocal words in the evidence that the voice's own description also uses. */
function fit(subject: CastSubject, voice: VoiceInfo): number {
  const evidence = subject.evidence.toLowerCase();
  let score = 0;
  for (const accent of ACCENTS) {
    if (evidence.includes(accent) && voice.tags.some((tag) => tag.toLowerCase().includes(accent))) score += 4;
  }
  for (const word of tagWords(voice)) if (evidence.includes(word)) score += 1;
  return Math.min(score, 8);
}

function similar(a: VoiceInfo, b: VoiceInfo): boolean {
  const left = tagWords(a), right = tagWords(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared) >= 0.5;
}

function overlap(a: readonly string[], b: readonly string[]): number {
  const set = new Set(b);
  return a.reduce((count, id) => count + (set.has(id) ? 1 : 0), 0);
}

interface ChoiceContext {
  voices: readonly VoiceInfo[];
  assigned: ReadonlyMap<string, string>;
  byId: ReadonlyMap<string, CastSubject>;
  narratorVoice?: string;
  majorLineCount: number;
  /** Skip these voices entirely; used when an engine cannot offer a distinct option. */
  blocked?: ReadonlySet<string>;
}

function score(subject: CastSubject, voice: VoiceInfo, context: ChoiceContext): number {
  if (context.blocked?.has(voice.id)) return Number.NEGATIVE_INFINITY;
  let total = fit(subject, voice);
  // A voice of the other gender is a last resort, chosen only when nothing else is left.
  if (subject.gender && (voice.tags.includes("female") || voice.tags.includes("male"))) total += voice.tags.includes(subject.gender) ? 6 : -50;
  const major = subject.lineCount >= context.majorLineCount;
  if (context.narratorVoice && voice.id === context.narratorVoice) total -= major ? 100 : 3;
  for (const [otherId, voiceId] of context.assigned) {
    if (otherId === subject.id) continue;
    const other = context.byId.get(otherId);
    const shared = other ? overlap(subject.sceneIds, other.sceneIds) : 0;
    // Two major roles never sharing a scene share a voice only when nothing else is left.
    const bothMajor = major && !!other && other.lineCount >= context.majorLineCount;
    if (voiceId === voice.id) total -= shared > 0 ? 8 + Math.min(3, shared) : bothMajor ? 6 : 0.75;
    else if (shared > 0) total -= 4 + Math.min(3, shared);
    const used = context.voices.find((candidate) => candidate.id === voiceId);
    if (used && shared > 0 && similar(voice, used)) total -= 1.5;
  }
  return total;
}

function bestVoice(subject: CastSubject, context: ChoiceContext): string | undefined {
  let best: { id: string; score: number } | undefined;
  for (const voice of [...context.voices].sort((a, b) => a.id.localeCompare(b.id))) {
    const value = score(subject, voice, context);
    if (!Number.isFinite(value)) continue;
    if (!best || value > best.score || (value === best.score && voice.id < best.id)) best = { id: voice.id, score: value };
  }
  return best?.id;
}

function majorThreshold(input: EnsembleInput): number {
  if (input.majorLineCount !== undefined) return Math.max(1, input.majorLineCount);
  const largest = input.subjects.reduce((max, subject) => Math.max(max, subject.lineCount), 0);
  return Math.max(4, Math.ceil(largest / 4));
}

function installed(input: EnsembleInput): VoiceInfo[] {
  const seen = new Set<string>();
  return input.voices.filter((voice) => voice.id && !seen.has(voice.id) && (seen.add(voice.id), true)).sort((a, b) => a.id.localeCompare(b.id));
}

/** Assign every unlocked role. The same inputs always produce the same map. */
export function assignEnsemble(input: EnsembleInput): Record<string, string> {
  const voices = installed(input);
  const byId = new Map(input.subjects.map((subject) => [subject.id, subject]));
  const assigned = new Map<string, string>();
  // A locked role keeps its voice even when automatic casting would never pick it (a novelty voice, say).
  for (const [id, voice] of Object.entries(input.locked ?? {})) if (byId.has(id) && voice) assigned.set(id, voice);
  const context: ChoiceContext = { voices, assigned, byId, narratorVoice: input.narratorVoice, majorLineCount: majorThreshold(input) };
  // Major roles choose first, so a minor role cannot take the voice a lead needed.
  const order = [...input.subjects].sort((a, b) => b.lineCount - a.lineCount || a.id.localeCompare(b.id));
  for (const subject of order) {
    if (assigned.has(subject.id)) continue;
    const voice = bestVoice(subject, context);
    if (voice) assigned.set(subject.id, voice);
  }
  return Object.fromEntries([...assigned.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Recast one character against the rest of the cast as it stands. Every other key in `current` is returned
 * unchanged, so a writer can reroll one role without disturbing the ensemble.
 */
export function recastCharacter(input: EnsembleInput & { current: Readonly<Record<string, string>> }, characterId: string): Record<string, string> {
  const result = { ...input.current };
  const subject = input.subjects.find((candidate) => candidate.id === characterId);
  const voices = installed(input);
  if (!subject || !voices.length) return result;
  const assigned = new Map(Object.entries(input.current).filter(([id, voice]) => id !== characterId && voices.some((v) => v.id === voice)));
  const context: ChoiceContext = {
    voices, assigned, byId: new Map(input.subjects.map((candidate) => [candidate.id, candidate])),
    narratorVoice: input.narratorVoice, majorLineCount: majorThreshold(input),
  };
  // "Recast" must actually offer a different voice when one exists, while still staying deterministic.
  const current = result[characterId];
  const blocked = new Set(current && voices.length > 1 ? [current] : []);
  const voice = bestVoice(subject, { ...context, blocked });
  if (voice) result[characterId] = voice;
  return result;
}

/** Up to three candidates for the side-by-side audition, best first and deterministic. */
export function auditionChoices(input: EnsembleInput & { current?: Readonly<Record<string, string>> }, characterId: string, count = 3): VoiceInfo[] {
  const subject = input.subjects.find((candidate) => candidate.id === characterId);
  const voices = installed(input);
  if (!subject || !voices.length) return [];
  const assigned = new Map(Object.entries(input.current ?? input.locked ?? {}).filter(([id, voice]) => id !== characterId && voices.some((v) => v.id === voice)));
  const context: ChoiceContext = {
    voices, assigned, byId: new Map(input.subjects.map((candidate) => [candidate.id, candidate])),
    narratorVoice: input.narratorVoice, majorLineCount: majorThreshold(input),
  };
  return voices
    .map((voice) => ({ voice, value: score(subject, voice, context) }))
    .filter((row) => Number.isFinite(row.value))
    .sort((a, b) => b.value - a.value || a.voice.id.localeCompare(b.voice.id))
    .slice(0, Math.max(1, count))
    .map((row) => row.voice);
}
