import test from "node:test";
import assert from "node:assert/strict";
import type { AiStatus, ProviderId } from "../src/shared/channels/ai.ts";
import { voiceInfos } from "../src/renderer/features/table-read/cast-ensemble.ts";
import { mergeAiCast, type CastSuggestion } from "../src/renderer/features/table-read/casting.ts";
import { preferredProvider as castingProvider } from "../src/renderer/features/assistant/provider.ts";

const status = (active: ProviderId, ready: ProviderId[]): Pick<AiStatus, "providers" | "active"> => ({
  active: { provider: active, model: "", contextChars: 0 },
  providers: (["ollama", "anthropic", "google", "openai", "chatgpt"] as const).map((provider) => ({ provider, ready: provider === "ollama" || ready.includes(provider) })),
});

test("casting and completion use the provider chosen in Settings, never a cloud provider the writer didn't pick", () => {
  assert.equal(castingProvider(status("ollama", [])), "ollama");
  assert.equal(castingProvider(status("ollama", ["chatgpt"])), "ollama", "Terra beta 5: Ollama chosen, ChatGPT signed in, casting offered ChatGPT");
  assert.equal(castingProvider(status("ollama", ["google", "chatgpt"])), "ollama");
  assert.equal(castingProvider(status("anthropic", ["anthropic", "chatgpt"])), "anthropic");
  assert.equal(castingProvider(status("chatgpt", ["chatgpt"])), "chatgpt");
  // A chosen cloud provider that isn't ready falls back to the local model, not to another cloud provider.
  assert.equal(castingProvider(status("anthropic", ["openai"])), "ollama");
  assert.equal(castingProvider(status("chatgpt", [])), "ollama");
});

const voices = voiceInfos([
  { id: "Samantha", label: "Samantha", language: "en-US", tags: ["female"] },
  { id: "Karen", label: "Karen", language: "en-AU", tags: ["female"] },
  { id: "Daniel", label: "Daniel", language: "en-GB", tags: ["male"] },
  { id: "Tom", label: "Tom", language: "en-US", tags: ["male"] },
], "system");
const subject = (id: string, lineCount: number) => ({ id, name: id.toUpperCase(), lineCount, sceneIds: ["s"], evidence: "" });
const pick = (id: string, voice: string, gender: CastSuggestion["gender"]): CastSuggestion => ({ id, voice, gender, reason: "" });

test("the model's picks are applied, and the ensemble fills skipped, duplicate or locked voices", () => {
  const subjects = [subject("maya", 9), subject("eli", 7), subject("joan", 5), subject("sam", 2)];
  const result = mergeAiCast({ subjects, voices, locked: { sam: "Tom" } }, [
    pick("maya", "Karen", "female"),
    pick("eli", "Karen", "male"), // already taken by MAYA
    pick("sam", "Daniel", "male"), // SAM is locked
    pick("ghost", "Samantha", "female"), // not in the cast
  ]);
  assert.equal(result.maya, "Karen");
  assert.equal(result.sam, "Tom");
  assert.equal(result.eli, "Daniel", "the model said ELI reads as a man, so the fill gives him the free male voice");
  assert.equal(result.joan, "Samantha");
});

test("a model pick outside the automatic pool is ignored", () => {
  const result = mergeAiCast({ subjects: [subject("maya", 3)], voices }, [pick("maya", "Bells", "female")]);
  assert.notEqual(result.maya, "Bells");
  assert.ok(["Samantha", "Karen", "Daniel", "Tom"].includes(result.maya!));
});

test("a gender the script states plainly outranks the model's guess", () => {
  const subjects = [{ ...subject("derek", 6), gender: "male" as const }, subject("charlie", 4)];
  const result = mergeAiCast({ subjects, voices }, [pick("derek", "Karen", "female"), pick("charlie", "Samantha", "female")]);
  assert.ok(["Daniel", "Tom"].includes(result.derek!), "the model's feminine pick for a man the script calls male is dropped");
  assert.equal(result.charlie, "Samantha", "the model's guess decides a role the script leaves open");
});

test("two leads who never share a scene still get different voices while any are left", async () => {
  const { assignEnsemble } = await import("../src/renderer/features/table-read/cast-ensemble.ts");
  const male = voiceInfos([
    { id: "Daniel", label: "Daniel", language: "en-GB", tags: ["male"] },
    { id: "Tom", label: "Tom", language: "en-US", tags: ["male"] },
  ], "system");
  const leads = [{ id: "tommy", name: "TOMMY", lineCount: 40, sceneIds: ["s1"], evidence: "", gender: "male" as const },
    { id: "mitchell", name: "MITCHELL", lineCount: 30, sceneIds: ["s2"], evidence: "", gender: "male" as const }];
  const result = assignEnsemble({ subjects: leads, voices: male });
  assert.notEqual(result.tommy, result.mitchell);
});

test("a first name settles gender only when the script says nothing plainly", async () => {
  const { nameGender } = await import("../src/renderer/features/table-read/first-names.ts");
  const { scriptGender } = await import("../src/renderer/features/table-read/cast-ensemble.ts");
  assert.equal(nameGender("MAYA SANTOS"), "female");
  assert.equal(nameGender("YOUNG JERRY"), "male");
  assert.equal(nameGender("DR. ELENA RUIZ"), "female");
  assert.equal(nameGender("CHARLIE"), undefined);
  assert.equal(nameGender("BOTTLES"), undefined);
  assert.equal(nameGender("THE KID", ["TOMMY"]), "male");
  assert.equal(scriptGender("DEREK", ["DEREK KIM (18) crouches behind them with a camera."]), "male");
  assert.equal(scriptGender("MAYA", ["MAYA, a man in his fifties, waits."]), "male", "a plain description outranks the name");
});

test("a first name does not overrule a pronoun that points the other way", async () => {
  const { scriptGender } = await import("../src/renderer/features/table-read/cast-ensemble.ts");
  assert.equal(scriptGender("MAYA", ["MAYA waits. He smiles."]), undefined);
  assert.equal(scriptGender("MAYA", ["MAYA waits. She smiles."]), "female");
});

test("a usable pick survives extra rows for characters that were not sent", async () => {
  const { parseCastProposal } = await import("../src/renderer/features/table-read/casting.ts");
  const context = {
    cast: [{ id: "m", name: "SAM", aliases: [], cueIds: [], voices: {}, locked: false }],
    inventory: [{ id: "Karen", label: "Karen", language: "en-AU", tags: ["female"] }],
    packets: [],
  } as any;
  const answer = JSON.stringify({ assignments: [{ id: "m", voice: "Karen", gender: "female" }, { id: "ghost", voice: "Karen", gender: "female" }] });
  assert.deepEqual(parseCastProposal(answer, context).map((row) => row.id), ["m"]);
});

test("an American cast keeps leads in American voices, from name matching and from the model", async () => {
  // Terra beta 6: MAYA, an American teenager, was cast as Bryony (en-GB).
  const { castAccent } = await import("../src/renderer/features/table-read/cast-ensemble.ts");
  const { assignEnsemble } = await import("../src/renderer/features/table-read/cast-ensemble.ts");
  const mixed = voiceInfos([
    { id: "Bryony", label: "Bryony", language: "en-GB", tags: ["female"] },
    { id: "Delia", label: "Delia", language: "en-US", tags: ["female"] },
    { id: "Ava", label: "Ava", language: "en-US", tags: ["female"] },
    { id: "Fergus", label: "Fergus", language: "en-GB", tags: ["male"] },
  ], "system");
  const maya = { ...subject("maya", 9), gender: "female" as const };
  const accent = castAccent("", ["en-gb", "en-us"], "en-US");
  assert.equal(accent, "en-us");
  assert.equal(assignEnsemble({ subjects: [maya], voices: mixed, accent }).maya, "Ava");
  assert.equal(mergeAiCast({ subjects: [maya], voices: mixed, accent }, [pick("maya", "Bryony", "female")]).maya, "Ava", "the model's British pick is dropped");
  // The script names her accent: then British is right.
  const british = { ...maya, evidence: "MAYA (17), British, all elbows." };
  assert.equal(mergeAiCast({ subjects: [british], voices: mixed, accent }, [pick("maya", "Bryony", "female")]).maya, "Bryony");
  // A regional accent counts for its language: a Scottish character may have a British voice in an American cast.
  const sailor = { ...subject("finn", 4), gender: "male" as const, evidence: "FINN, a Scottish sailor, coils rope." };
  const men = voiceInfos([{ id: "Fergus", label: "Fergus", language: "en-GB", tags: ["male"] }, { id: "Tom", label: "Tom", language: "en-US", tags: ["male"] }], "system");
  assert.equal(assignEnsemble({ subjects: [sailor], voices: men, accent }).finn, "Fergus");
  assert.equal(assignEnsemble({ subjects: [{ ...sailor, evidence: "FINN coils rope. His English teacher waves." }], voices: men, accent }).finn, "Tom");
  // Whole words only: "Americana" doesn't name an accent.
  const collector = { ...maya, evidence: "MAYA collects Americana." };
  assert.equal(mergeAiCast({ subjects: [collector], voices: mixed, accent: "en-gb" }, [pick("maya", "Ava", "female")]).maya, "Bryony");
  // A British Mac defaults to British; "any" turns the preference off; an accent with no voices is ignored.
  assert.equal(castAccent("", ["en-gb", "en-us"], "en-GB"), "en-gb");
  assert.equal(castAccent("any", ["en-gb", "en-us"], "en-US"), undefined);
  assert.equal(castAccent("en-au", ["en-gb", "en-us"], "en-US"), undefined);
});

test("filling an empty cast takes voices in the cast's accent first", async () => {
  const { fillCast } = await import("../src/renderer/features/table-read/casting.ts");
  const state = { version: 1 as const, narrator: {}, cast: [{ id: "m", name: "MAYA", aliases: [], cueIds: [], voices: {}, locked: false }] };
  const inventory = [
    { id: "Bryony", label: "Bryony", language: "en-GB", tags: ["female"] },
    { id: "Delia", label: "Delia", language: "en-US", tags: ["female"] },
    { id: "Ava", label: "Ava", language: "en-US", tags: ["female"] },
  ];
  const filled = fillCast(state as any, "system", inventory, false, { MAYA: "female" }, "en-us");
  // Both American: the narrator takes the first, MAYA the next; Bryony waits until those run out.
  assert.deepEqual([filled.narrator.system, filled.cast[0]!.voices.system], ["Delia", "Ava"]);
});
