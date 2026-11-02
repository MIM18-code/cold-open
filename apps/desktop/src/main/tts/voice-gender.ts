// How each installed voice presents, so automatic casting can give MOTHER a woman's voice. Voices not listed
// get no tag and casting treats them as a fit for anyone.
import type { ReadEngine } from "../../shared/channels/table-read.ts";

export type VoiceGender = "female" | "male";

// macOS English voices by base name ("Ava (Premium)" is Ava).
const SYSTEM_FEMALE = new Set(["Allison", "Ava", "Catherine", "Fiona", "Isha", "Joelle", "Karen", "Kate", "Matilda", "Moira", "Nicky",
  "Noelle", "Samantha", "Sangeeta", "Serena", "Stephanie", "Susan", "Tara", "Tessa", "Veena", "Zoe"]);
const SYSTEM_MALE = new Set(["Aaron", "Alex", "Aman", "Arthur", "Daniel", "Evan", "Gordon", "Jamie", "Lee", "Malcolm", "Nathan", "Oliver",
  "Rishi", "Tom"]);

// Phonon's English presets (en_us_*, en_gb_*).
const PHONON_FEMALE = new Set(["Delia", "Everly", "Hadley", "Harper", "Juniper", "Zoey", "Bryony", "Elodie-Rose", "Freya", "Imogen",
  "Lottie", "Maeve", "Pippa"]);
const PHONON_MALE = new Set(["Easton", "Micah", "Miles", "Preston", "Russell", "Trevor", "Alfie", "Edwin", "Hugh", "Spencer", "Teddy", "Toby"]);

const MING: Record<string, VoiceGender> = { US_Emma: "female", UK_George: "male", UK_Charlotte: "female" };

export function voiceGender(engine: ReadEngine | "system", id: string): VoiceGender | undefined {
  if (engine === "system") {
    const base = id.replace(/\s*\(.*$/, "").trim();
    return SYSTEM_FEMALE.has(base) ? "female" : SYSTEM_MALE.has(base) ? "male" : undefined;
  }
  // Kokoro IDs say it: af_/bf_ are female, am_/bm_ male.
  if (engine === "kokoro") return /^[ab]f_/.test(id) ? "female" : /^[ab]m_/.test(id) ? "male" : undefined;
  if (engine === "ming") return MING[id];
  if (engine === "phonon") {
    const name = /^en_(?:us|gb)_(.+)$/.exec(id)?.[1];
    return name ? PHONON_FEMALE.has(name) ? "female" : PHONON_MALE.has(name) ? "male" : undefined : undefined;
  }
  return undefined;
}

/** Tags for a voice: its gender when known, and "novelty" for Phonon's fantasy character presets. */
export function voiceTags(engine: ReadEngine | "system", id: string, extra: readonly string[] = []): string[] | undefined {
  const tags = [...extra];
  const gender = voiceGender(engine, id);
  if (gender) tags.push(gender);
  if (engine === "phonon" && id.startsWith("characters_")) tags.push("novelty");
  return tags.length ? tags : undefined;
}
