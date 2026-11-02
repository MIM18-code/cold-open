import test from "node:test";
import assert from "node:assert/strict";
import { answerSentence, completionFrom, completionRequest, unfinishedSentence } from "../src/renderer/features/autocomplete/complete.ts";
import { preferredProvider } from "../src/renderer/features/assistant/provider.ts";

test("the unfinished sentence is what follows the last sentence end", () => {
  assert.equal(unfinishedSentence("She stops. Turns to the"), "Turns to the");
  assert.equal(unfinishedSentence("Wait! \"Who's there?\" Nothing. Then a kn"), "Then a kn");
  assert.equal(unfinishedSentence("She stops."), "");
  assert.equal(unfinishedSentence("She stops. "), "");
  assert.equal(unfinishedSentence("Mr. Kim"), "Kim", "an abbreviation ends a sentence too; the model still sees the whole line");
  assert.equal(unfinishedSentence("No punctuation yet"), "No punctuation yet");
});

test("only an answer that keeps every typed character is used, with spacing worked out from what was typed", () => {
  // Mid-word: the model finishes the word, so no space is added.
  assert.equal(completionFrom("Then a kn", "Then a kn", "Then a knock at the door."), "ock at the door.");
  // After a space the writer typed, the answer's own space is not doubled.
  assert.equal(completionFrom("She turns to the ", "She turns to the ", "She turns to the window."), "window.");
  // At a word end without a space, the answer brings its space.
  assert.equal(completionFrom("She turns", "She turns", "She turns away."), " away.");
  // A finished sentence gets a new one after a space.
  assert.equal(completionFrom("She stops.", "", "She looks back."), " She looks back.");
  assert.equal(completionFrom("She stops. ", "", "She looks back."), "She looks back.");
  // A rewrite of the typed words is refused, and so is an answer that adds nothing.
  assert.equal(completionFrom("She turns to the", "She turns to the", "He turns to the door."), null);
  assert.equal(completionFrom("She turns.", "She turns.", "She turns."), null);
  const long = completionFrom("He", "He", `He ${"runs ".repeat(40)}`)!;
  assert.equal(long.trim().split(/\s+/).length, 25);
});

test("the request carries the scene, the speaker and the unfinished sentence, and notes stay out", () => {
  const p = (id: string, type: any, text: string) => ({ id, type, runs: [{ text }] });
  const request = completionRequest({ before: [p("s", "sceneHeading", "int. diner - night"), p("a", "action", "Rain on the glass."), p("c", "character", "MAYA")],
    type: "dialogue", speaker: "MAYA", prefix: "I told you. Never come back h" });
  assert.equal(request.fragment, "Never come back h");
  const content = request.messages[0]!.content as string;
  assert.match(content, /INT\. DINER - NIGHT/);
  assert.match(content, /dialogue spoken by MAYA/);
  assert.match(content, /"Never come back h"/);
  assert.match(request.system, /every character unchanged/);
});

test("an answer is read from JSON or, failing that, from plain text", () => {
  assert.equal(answerSentence('{"sentence":"She runs."}'), "She runs.");
  assert.equal(answerSentence('```json\n{"sentence":"She runs."}\n```'), "She runs.");
  assert.equal(answerSentence('"She runs."'), "She runs.");
});

test("completion uses the same provider rule as casting", () => {
  const status = (ready: string[]) => ({ active: { provider: "ollama" as const, model: "", contextChars: 0 },
    providers: ["ollama", "chatgpt", "anthropic"].map((provider) => ({ provider: provider as any, ready: provider === "ollama" || ready.includes(provider) })) });
  assert.equal(preferredProvider(status([])), "ollama");
  assert.equal(preferredProvider(status(["chatgpt"])), "chatgpt");
});

test("small-model habits are tolerated: wrapping quotes, curly apostrophes, bare continuations and narration", () => {
  assert.equal(completionFrom("I swear I'll do it ", "I swear I'll do it ", "\"I swear I’ll do it right this time.\""), "right this time.");
  assert.equal(completionFrom("I swear I'll do it ", "I swear I'll do it ", "\"I swear I'll do it,\" he said, tears streaming."), null);
  assert.equal(completionFrom("I swear I'll do it ", "I swear I'll do it ", "\"I swear I'll do it now,\" he said."), "now");
  assert.equal(completionFrom("And Maya - she's not ", "And Maya - she's not ", "alive."), "alive.");
  assert.equal(completionFrom("And Maya — she’s not", "And Maya — she’s not", "and maya - she's not coming back."), " coming back.");
  assert.equal(completionFrom("She turns", "She turns", "He leaves."), null);
});

test("after a typed space, a completion never starts with a comma or a full stop", () => {
  assert.equal(completionFrom("I swear I'll do it ", "I swear I'll do it ", "I swear I'll do it, please let me go."), "please let me go.");
  assert.equal(completionFrom("I swear I'll do it ", "I swear I'll do it ", "I swear I'll do it."), null);
});

test("an answer that repeats the whole line, not just the unfinished sentence, still works", () => {
  assert.equal(completionFrom("Rain on the glass. Then a kn", "Then a kn", "Rain on the glass. Then a knock at the door."), "ock at the door.");
});

test("inline notes never reach the prompt, and the caret offset still lines up", async () => {
  const { visibleBefore, visibleText } = await import("../src/renderer/features/autocomplete/complete.ts");
  const runs = [{ text: "Rain on the glass. " }, { text: "PRIVATE", note: true as const }, { text: "Then a kn" }];
  assert.equal(visibleText(runs), "Rain on the glass. Then a kn");
  assert.equal(visibleBefore(runs, 19 + 7 + 9), "Rain on the glass. Then a kn");
  assert.equal(visibleBefore(runs, 22), "Rain on the glass. ");
  const request = completionRequest({ before: [{ id: "a", type: "action", runs } as any], type: "action", prefix: visibleBefore(runs, 35) });
  assert.doesNotMatch(request.messages[0]!.content as string, /PRIVATE/);
});
