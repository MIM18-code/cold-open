import test from "node:test";
import assert from "node:assert/strict";
import { voiceGender, voiceTags } from "../src/main/tts/voice-gender.ts";
import { assignEnsemble, characterGender, voiceInfos } from "../src/renderer/features/table-read/cast-ensemble.ts";
import { fillCast, type CastState } from "../src/renderer/features/table-read/casting.ts";

test("voices carry their gender, and Phonon's character presets count as novelty", () => {
  assert.equal(voiceGender("system", "Daniel"), "male");
  assert.equal(voiceGender("system", "Ava (Premium)"), "female");
  assert.equal(voiceGender("system", "Samantha"), "female");
  assert.equal(voiceGender("kokoro", "af_heart"), "female");
  assert.equal(voiceGender("kokoro", "bm_george"), "male");
  assert.equal(voiceGender("phonon", "en_gb_Imogen"), "female");
  assert.equal(voiceGender("ming", "UK_George"), "male");
  assert.equal(voiceGender("system", "Unknown Voice"), undefined);
  assert.deepEqual(voiceTags("phonon", "characters_Azgorath"), ["novelty"]);
});

test("character gender comes from role words, then clear pronoun majorities in action", () => {
  assert.equal(characterGender("MOTHER", []), "female");
  assert.equal(characterGender("MRS. KIM", []), "female");
  assert.equal(characterGender("BROTHER", []), "male");
  assert.equal(characterGender("OLD MAN", []), "male");
  assert.equal(characterGender("MAYA", ["MAYA (17) grabs her bag. She heads for the door, her keys in hand."]), "female");
  assert.equal(characterGender("DEREK", ["DEREK shoves his hands in his pockets. He waits."]), "male");
  assert.equal(characterGender("SAM", ["SAM looks at her. He nods."]), undefined);
  assert.equal(characterGender("SAM", []), undefined);
  assert.equal(characterGender("JOHN", ["JOHN, a man, watches MAYA. She grabs her coat and leaves."], ["JOHN", "MAYA"]), "male");
  assert.equal(characterGender("JOHN", ["JOHN watches MAYA. She grabs her coat and leaves."], ["JOHN", "MAYA"]), undefined);
  assert.equal(characterGender("MAYA", ["Maya watches John. He grabs his coat and leaves."], ["JOHN", "MAYA"]), undefined);
  assert.equal(characterGender("THE MAN IN BLACK", ["THE MAN IN BLACK removes her helmet. She shakes out her hair."]), "female");
  assert.equal(characterGender("THE MAN IN BLACK", ["THE MAN IN BLACK removes her helmet. She smiles."]), undefined);
  assert.equal(characterGender("THE MAN IN BLACK", ["THE MAN IN BLACK, a woman, removes the helmet."]), "female");
  assert.equal(characterGender("MAYA", ["MAYA, a woman, watches JOHN. He grabs his coat and leaves."], ["JOHN SMITH", "JOHN"]), "female");
  assert.equal(characterGender("MAYA", ["MAYA watches a man. He grabs his coat and leaves."], []), undefined);
  assert.equal(characterGender("JOHN SMITH", ["John grabs his coat. He leaves."], ["MAYA"], ["JOHN"]), "male");
  assert.equal(characterGender("MAYA", ["MAYA, a man's jacket draped over her shoulders, waits. She checks her watch."], []), undefined);
  assert.equal(characterGender("ANN", ["JOANN, a woman, watches ANN. He adjusts his tie."], ["JOANN"]), undefined);
  assert.equal(characterGender("ALEX", ["ALEX pulls his hat low. ALEX watches a woman. She grabs her coat and leaves."], ["MAN"]), undefined);
  assert.equal(characterGender("MOTHER", ["Mother's wig settles over his head. The set buries him."], ["MOTHER", "JERRY"]), "female");
  assert.equal(characterGender("JERRY", ["She follows Jerry's breadcrumbs into the sector. Behind her, a shadow moves."], ["JERRY", "MAYA"]), undefined);
  assert.equal(characterGender("MAYA (V.O.)", ["Maya grabs her bag. She runs."], ["MAYA", "DEREK"]), "female");
});

test("automatic casting gives each character a voice of their gender when one is free", () => {
  const voices = [
    { id: "Daniel", label: "Daniel", language: "en-GB", tags: ["male"] },
    { id: "Eddy", label: "Eddy", language: "en-GB", tags: ["male"] },
    { id: "Karen", label: "Karen", language: "en-AU", tags: ["female"] },
    { id: "Moira", label: "Moira", language: "en-IE", tags: ["female"] },
    { id: "Reed", label: "Reed", language: "en-US", tags: ["male"] },
  ];
  const state: CastState = { version: 1, narrator: {}, cast: ["MOTHER", "MAYA", "BROTHER"].map((name) => ({ id: name, name, aliases: [], cueIds: [], voices: {}, locked: false })) };
  const filled = fillCast(state, "system", voices, false, { MOTHER: "female", MAYA: "female", BROTHER: "male" });
  const by = Object.fromEntries(filled.cast.map((b) => [b.name, b.voices.system]));
  assert.ok(["Karen", "Moira"].includes(by.MOTHER!) && ["Karen", "Moira"].includes(by.MAYA!) && by.MOTHER !== by.MAYA);
  assert.ok(["Eddy", "Reed"].includes(by.BROTHER!));
  const ensemble = assignEnsemble({ voices: voiceInfos(voices, "system"), narratorVoice: "Daniel", subjects: [
    { id: "m", name: "MOTHER", lineCount: 6, sceneIds: ["s"], evidence: "", gender: "female" },
    { id: "b", name: "BROTHER", lineCount: 5, sceneIds: ["s"], evidence: "", gender: "male" },
  ] });
  assert.ok(["Karen", "Moira"].includes(ensemble.m!));
  assert.ok(["Eddy", "Reed"].includes(ensemble.b!));
});

test("AI casting reads gender from context, sees voice tags, and cannot give a woman a male voice", async () => {
  const { castingRequest, parseCastProposal, requestCastProposal } = await import("../src/renderer/features/table-read/casting.ts");
  const context = {
    cast: [{ id: "m", name: "MOTHER", aliases: [], cueIds: [], voices: {}, locked: false }],
    inventory: [{ id: "Daniel", label: "Daniel", language: "en-GB", tags: ["masculine", "adult", "British English", "male"] },
      { id: "Karen", label: "Karen", language: "en-AU", tags: ["feminine", "adult", "Australian English", "female"] }],
    packets: [{ characterId: "m", name: "MOTHER", fingerprint: "f", lineCount: 3, wordCount: 20, sceneCount: 1, sceneIds: ["s"], lines: [], descriptions: [], parentheticals: [], anchors: ["p1"] }],
  } as any;
  const prompt = castingRequest(context);
  assert.match(prompt.system, /woman, a man, or unclear/);
  assert.match(prompt.messages[0]!.content as string, /"feminine"/);
  const wrong = JSON.stringify({ assignments: [{ id: "m", voice: "Daniel", gender: "female", reason: "Her son calls her Mom.", evidence: ["p1"] }] });
  assert.throws(() => parseCastProposal(wrong, context), /other gender/);
  const right = JSON.stringify({ assignments: [{ id: "m", voice: "Karen", gender: "female", reason: "Her son calls her Mom.", evidence: ["p1"] }] });
  const answers = [wrong, right];
  const suggestions = await requestCastProposal(async () => answers.shift()!, context);
  assert.deepEqual(suggestions.map((s) => [s.voice, s.gender]), [["Karen", "female"]]);
});

test("a casting answer must state gender, and a voice tagged both ways fits either", async () => {
  const { parseCastProposal } = await import("../src/renderer/features/table-read/casting.ts");
  const context = {
    cast: [{ id: "m", name: "MOTHER", aliases: [], cueIds: [], voices: {}, locked: false }],
    inventory: [{ id: "Daniel", label: "Daniel", language: "en-GB", tags: ["masculine", "male"] }, { id: "Ref", label: "Ref", language: "en", tags: ["female", "male"] }],
    packets: [{ characterId: "m", name: "MOTHER", fingerprint: "f", lineCount: 1, wordCount: 1, sceneCount: 1, sceneIds: [], lines: [], descriptions: [], parentheticals: [], anchors: ["p1"] }],
  } as any;
  assert.throws(() => parseCastProposal(JSON.stringify({ assignments: [{ id: "m", voice: "Daniel", evidence: ["p1"] }] }), context), /female, male or unclear/);
  assert.equal(parseCastProposal(JSON.stringify({ assignments: [{ id: "m", voice: "Ref", gender: "female", evidence: ["p1"] }] }), context)[0]!.voice, "Ref");
});
