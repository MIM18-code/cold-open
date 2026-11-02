import type { ReadEngine, ReadVoice } from "../../shared/channels/table-read.ts";

const curated: Record<string, string[]> = {
  af_heart: ["feminine", "adult", "American English", "warm", "rounded"],
  af_bella: ["feminine", "adult", "American English", "bright", "soft"],
  af_nicole: ["feminine", "adult", "American English", "breathy", "light"],
  af_sky: ["feminine", "young adult", "American English", "light", "bright"],
  am_adam: ["masculine", "adult", "American English", "low", "firm"],
  am_michael: ["masculine", "adult", "American English", "rounded", "steady"],
  bf_isabella: ["feminine", "adult", "British English", "rounded", "warm"],
  bm_george: ["masculine", "adult", "British English", "low", "measured"],
  bm_lewis: ["masculine", "adult", "British English", "light", "clear"],
  US_Emma: ["feminine", "adult", "American English", "clear", "steady"],
  UK_George: ["masculine", "adult", "British English", "low", "rounded"],
  UK_Charlotte: ["feminine", "adult", "British English", "clear", "measured"],
  Samantha: ["feminine", "adult", "American English", "clear", "steady"],
  Alex: ["masculine", "adult", "American English", "rounded", "steady"],
  Daniel: ["masculine", "adult", "British English", "low", "measured"],
  Karen: ["feminine", "adult", "Australian English", "clear", "steady"],
  Moira: ["feminine", "adult", "Irish English", "rounded", "steady"],
};
// Descriptors are audition guidance, not demographic claims about a recorded person.
// Unreviewed installed voices remain selectable without invented age/timbre metadata.
const FLAGS = new Set(["novelty", "female", "male"]);
export function describeVoice(engine: ReadEngine, voice: ReadVoice): ReadVoice {
  const tags = curated[voice.id] ?? [
    /^(af|bf)_/.test(voice.id) ? "feminine" : /^(am|bm)_/.test(voice.id) ? "masculine" : "presentation unreviewed",
    "age unreviewed", voice.language, "timbre unreviewed"
  ];
  // Flags from the voice list (novelty, female/male) add to the description; a voice's own
  // descriptive tags (a designed Qwen reference) replace it. A known gender also settles "presentation unreviewed".
  const own = voice.tags ?? [], descriptive = own.filter((tag) => !FLAGS.has(tag));
  const gender = own.includes("female") ? "feminine" : own.includes("male") ? "masculine" : undefined;
  const base = descriptive.length ? descriptive : tags.map((tag) => (tag === "presentation unreviewed" && gender ? gender : tag));
  return { ...voice, engine, tags: [...new Set([...base, ...own.filter((tag) => FLAGS.has(tag))])] };
}
export function voiceCatalogue(inventory: Partial<Record<ReadEngine, ReadVoice[]>>): ReadVoice[] {
  return Object.entries(inventory).flatMap(([engine, voices]) => voices.map((v) => describeVoice(engine as ReadEngine, v)));
}
