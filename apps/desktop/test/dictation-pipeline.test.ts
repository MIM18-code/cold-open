// The pipeline with a fake speech engine and a fake formatter, plus settings and error messages.
import { type Formatter, type Proposal, type SpeechEngine, type Transcript } from "@screenplay/dictation";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { HELPER_RELATIVE, readConfig, resolveHelperPath } from "../src/main/dictation/config.ts";
import { explainError } from "../src/main/dictation/errors.ts";
import { DictationPipeline, modelContext } from "../src/main/dictation/pipeline.ts";
import { EMPTY_CONTEXT, type ProgressStage, type TakeContext } from "../src/shared/channels/dictation.ts";
import { encodeWav } from "../src/renderer/features/dictation/wav.ts";

const lookup = { repoRoot: "/repo", exists: () => false };
const config = readConfig({}, lookup);
const audio = encodeWav([new Float32Array(16000)]);
const SPOKEN = "Interior kitchen night. Maya stands at the sink. Maya says, I can't do this anymore.";

const proposal: Proposal = {
  elements: [
    { type: "scene_heading", text: "INT. KITCHEN - NIGHT", source_quote: "Interior kitchen night.", uncertainty: "" },
    { type: "action", text: "Maya stands at the sink.", source_quote: "Maya stands at the sink.", uncertainty: "" },
    { type: "character", text: "MAYA", source_quote: "Maya says, I can't do this anymore.", uncertainty: "" },
    { type: "dialogue", text: "I can't do this anymore.", source_quote: "I can't do this anymore.", uncertainty: "" },
  ],
  omissions: [],
  warnings: [],
};

function fakeSpeech(text: string, log: string[] = []): SpeechEngine {
  return {
    name: "fake",
    async prepare() {
      log.push("prepare");
    },
    async transcribe(path): Promise<Transcript> {
      log.push(`transcribe ${existsSync(path) ? "file" : "missing"}`);
      return { engine: "fake", text, words: [], audioSeconds: 1, transcribeMs: 5 };
    },
  };
}

function fakeFormatter(result: Proposal | Error, seen: { transcript?: string; context?: Record<string, unknown> } = {}): Formatter {
  return {
    async format(transcript, context) {
      seen.transcript = transcript;
      seen.context = context;
      if (result instanceof Error) throw result;
      return structuredClone(result);
    },
  };
}

test("an audio take is transcribed, formatted and mapped to engine types", async () => {
  const log: string[] = [];
  const stages: ProgressStage[] = [];
  const seen: { transcript?: string; context?: Record<string, unknown> } = {};
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(SPOKEN, log), formatter: () => fakeFormatter(proposal, seen) });
  const context: TakeContext = { ...EMPTY_CONTEXT, characters: ["MAYA"], currentHeading: "INT. HALL - DAY", referenceText: "earlier" };
  const take = await pipeline.processAudio({ takeId: 7, audio, context }, config, (stage) => stages.push(stage));
  assert.equal(take.takeId, 7);
  assert.equal(take.source, "audio");
  assert.equal(take.engine, "fake");
  assert.equal(take.transcript, SPOKEN);
  assert.deepEqual(take.elements.map((e) => e.type), ["sceneHeading", "action", "character", "dialogue"]);
  assert.deepEqual(take.diagnostics, []);
  assert.equal(take.error, undefined);
  assert.deepEqual(stages, ["saved", "transcribing", "formatting", "done"]);
  assert.deepEqual(log, ["prepare", "transcribe file"]);
  assert.equal(seen.transcript, SPOKEN);
  assert.deepEqual(seen.context, modelContext(context));
  assert.ok(take.timings.totalMs >= take.timings.formatMs);
});

test("the recording is deleted after the helper has read it", async () => {
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith("screenplay-dictation-"));
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(SPOKEN), formatter: () => fakeFormatter(proposal) });
  await pipeline.processAudio({ takeId: 1, audio, context: EMPTY_CONTEXT }, config);
  const after = readdirSync(tmpdir()).filter((name) => name.startsWith("screenplay-dictation-"));
  assert.deepEqual(after, before);
});

test("the speech model loads once", async () => {
  const log: string[] = [];
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(SPOKEN, log), formatter: () => fakeFormatter(proposal) });
  await pipeline.processAudio({ takeId: 1, audio, context: EMPTY_CONTEXT }, config);
  await pipeline.processAudio({ takeId: 2, audio, context: EMPTY_CONTEXT }, config);
  assert.equal(log.filter((entry) => entry === "prepare").length, 1);
});

test("a helper that restarted is prepared again and the take still goes through", async () => {
  let calls = 0;
  const log: string[] = [];
  const flaky: SpeechEngine = {
    name: "flaky",
    async prepare() {
      log.push("prepare");
    },
    async transcribe() {
      if (calls++ === 0) throw new Error("Prepare parakeet first.");
      return { engine: "flaky", text: SPOKEN, words: [], audioSeconds: 1, transcribeMs: 1 };
    },
  };
  const pipeline = new DictationPipeline({ speech: () => flaky, formatter: () => fakeFormatter(proposal) });
  const take = await pipeline.processAudio({ takeId: 1, audio, context: EMPTY_CONTEXT }, config);
  assert.equal(take.transcript, SPOKEN);
  assert.equal(log.length, 2);
});

test("a recording with no speech is an error, not an empty take", async () => {
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech("  "), formatter: () => fakeFormatter(proposal) });
  await assert.rejects(pipeline.processAudio({ takeId: 1, audio, context: EMPTY_CONTEXT }, config), /No speech was found/);
});

test("bytes that are not a WAV file never reach the helper", async () => {
  const log: string[] = [];
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(SPOKEN, log), formatter: () => fakeFormatter(proposal) });
  await assert.rejects(pipeline.processAudio({ takeId: 1, audio: new Uint8Array(500), context: EMPTY_CONTEXT }, config), /not a WAV/);
  assert.deepEqual(log, []);
});

test("a formatting failure keeps the transcript and says what to do", async () => {
  const pipeline = new DictationPipeline({
    speech: () => fakeSpeech(SPOKEN),
    formatter: () => fakeFormatter(new Error("Could not use the local model server: fetch failed")),
  });
  const take = await pipeline.processAudio({ takeId: 1, audio, context: EMPTY_CONTEXT }, config);
  assert.equal(take.transcript, SPOKEN);
  assert.deepEqual(take.elements, []);
  assert.equal(take.needsFormatterSetup, true);
  assert.match(take.error ?? "", /Set up the local formatting model/);
});

test("typed text goes through the same formatting", async () => {
  const seen: { transcript?: string } = {};
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(""), formatter: () => fakeFormatter(proposal, seen) });
  const take = await pipeline.processText({ takeId: 3, text: `  ${SPOKEN}\n`, context: EMPTY_CONTEXT }, config);
  assert.equal(take.source, "text");
  assert.equal(seen.transcript, SPOKEN);
  assert.equal(take.elements.length, 4);
  await assert.rejects(pipeline.processText({ takeId: 4, text: "  ", context: EMPTY_CONTEXT }, config), /no text/);
});

test("a parenthetical comes back with its brackets and a warning from the checks is a diagnostic", async () => {
  const text = "Tommy says, whispering, get down.";
  const parenthetical: Proposal = {
    elements: [
      { type: "character", text: "TOMMY", source_quote: "Tommy says, whispering, get down.", uncertainty: "" },
      { type: "parenthetical", text: "whispering", source_quote: "whispering,", uncertainty: "" },
      { type: "dialogue", text: "Get down.", source_quote: "get down.", uncertainty: "" },
    ],
    omissions: [], warnings: ["one note"],
  };
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(text), formatter: () => fakeFormatter(parenthetical) });
  const take = await pipeline.processText({ takeId: 1, text, context: EMPTY_CONTEXT }, config);
  assert.equal(take.elements[1]!.text, "(whispering)");
  assert.deepEqual(take.warnings, ["one note"]);
});

test("spoken edit commands become suggestions and are not formatted", async () => {
  const seen: { transcript?: string } = {};
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(""), formatter: () => fakeFormatter(proposal, seen) });
  const take = await pipeline.processText({ takeId: 1, text: `${SPOKEN} Change Maya to Mia everywhere.`, context: EMPTY_CONTEXT }, config);
  assert.equal(seen.transcript, SPOKEN);
  assert.deepEqual(take.commands.map((c) => [c.find, c.replacement, c.scope]), [["Maya", "Mia", "script"]]);
  assert.equal(take.transcript.endsWith("everywhere."), true, "the transcript still shows what was said");
});

test("a take that is only an edit command skips the model entirely", async () => {
  const formatter: Formatter = { format: () => assert.fail("the model should not be asked") };
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(""), formatter: () => formatter });
  const take = await pipeline.processText({ takeId: 1, text: "Change Bob to Robert everywhere.", context: EMPTY_CONTEXT }, config);
  assert.equal(take.elements.length, 0);
  assert.equal(take.commands.length, 1);
  assert.equal(take.error, undefined);
});

test("a writer can keep the sentence as script text", async () => {
  const seen: { transcript?: string } = {};
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(""), formatter: () => fakeFormatter(proposal, seen) });
  const text = "Replace the battery with a new one.";
  const take = await pipeline.processText({ takeId: 1, text, context: EMPTY_CONTEXT, extractCommands: false }, config);
  assert.equal(take.commands.length, 0);
  assert.equal(seen.transcript, text);
});

test("settings default to Writers Block's model and are read from the settings store", () => {
  assert.equal(config.engine, "parakeet");
  assert.equal(config.formatter.provider, "ollama");
  assert.equal(config.formatter.endpoint, "http://127.0.0.1:11434");
  assert.equal(config.formatter.model, "qwen3.5:4b");
  assert.equal(config.formatter.localServerConfirmed, true);
  const custom = readConfig({
    "dictation.engine": "whisper", "dictation.model": " gemma4:e4b ", "dictation.provider": "compatible", "dictation.localConfirmed": false,
    "dictation.endpoint": "http://127.0.0.1:1234/v1", "dictation.engine.bogus": 1,
  }, lookup);
  assert.equal(custom.engine, "whisper");
  assert.equal(custom.formatter.model, "gemma4:e4b");
  assert.equal(custom.formatter.provider, "compatible");
  assert.equal(custom.formatter.localServerConfirmed, false);
  assert.equal(readConfig({ "dictation.engine": "nope" }, lookup).engine, "parakeet");
});

test("the helper is found next to the checkout, then in the main checkout of a worktree", () => {
  const built = (path: string) => path === `/Users/me/App/${HELPER_RELATIVE}`;
  const here = resolveHelperPath("", { repoRoot: "/Users/me/App", exists: built });
  assert.equal(here, `/Users/me/App/${HELPER_RELATIVE}`);
  const worktree = resolveHelperPath("", { repoRoot: "/Users/me/App/.claude/worktrees/w1", exists: built });
  assert.equal(worktree, `/Users/me/App/${HELPER_RELATIVE}`);
  const env = resolveHelperPath("", { repoRoot: "/Users/me/App", exists: () => true, env: { SCREENPLAY_SPEECH_HELPER: "/opt/helper" } });
  assert.equal(env, "/opt/helper");
  const packaged = resolveHelperPath("", { repoRoot: "/x", resourcesPath: "/App/Resources", exists: (path) => path === "/App/Resources/speech-helper" });
  assert.equal(packaged, "/App/Resources/speech-helper");
});

test("a path from Settings is used as given, even when it is wrong", () => {
  assert.equal(resolveHelperPath("/nowhere/helper", { repoRoot: "/Users/me/App", exists: () => true }), "/nowhere/helper");
  assert.equal(resolveHelperPath("", { repoRoot: "/nothing", exists: () => false }), `/nothing/${HELPER_RELATIVE}`);
});

test("failures say what to do", () => {
  assert.match(explainError(new Error("Speech helper could not start: spawn /x ENOENT"), config), /swift build -c release/);
  assert.match(explainError(new Error("Parakeet Core ML weights are not downloaded. Run `speech-helper download --engine parakeet` once."), config), /download --engine parakeet/);
  assert.match(explainError(new Error("Local model server returned HTTP 404. No cloud fallback was used. model 'qwen3.5:4b' not found"), config), /Set up the local formatting model/);
  assert.match(explainError(new Error("Could not use the local model server: fetch failed"), config), /Set up the local formatting model/);
  assert.match(explainError(new Error("Could not use the local model server: The operation was aborted due to timeout"), config), /did not answer in time/);
  assert.equal(explainError(new Error("Something else."), config), "Something else.");
});

test("text formatting exposes strict auto-apply checks without rewriting spoken commands", async () => {
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(""), formatter: () => fakeFormatter(proposal) });
  const take = await pipeline.processText({ takeId: 99, text: SPOKEN, context: EMPTY_CONTEXT, extractCommands: false }, config);
  assert.deepEqual(take.autoApplyErrors, []);
  assert.deepEqual(take.commands, []);
});

test("text-format cancellation propagates to the formatter and rejects the response", async () => {
  let signalSeen: AbortSignal | undefined;
  const controller = new AbortController();
  const pipeline = new DictationPipeline({ speech: () => fakeSpeech(""), formatter: () => ({
    async format(_text, _context, signal) {
      signalSeen = signal;
      controller.abort();
      return structuredClone(proposal);
    },
  }) });
  await assert.rejects(pipeline.processText({ takeId: 100, text: SPOKEN, context: EMPTY_CONTEXT }, config, () => {}, controller.signal));
  assert.equal(signalSeen, controller.signal);
});
