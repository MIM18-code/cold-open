import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VoiceModelManager } from "../src/main/models/voice-manager.ts";
import { VOICE_PACKS, noticeText, packChecksum, performancePack, validateVoicePack, type VoicePack } from "../src/main/models/voice-manifest.ts";
import { audioKey, type SpeechIdentity } from "../src/main/tts/cache-key.ts";
import { ReferenceBank, referenceChecksum } from "../src/main/tts/reference-bank.ts";
import { ReaderRuntime } from "../src/main/tts/runtime.ts";
import { VoiceWorker } from "../src/main/tts/worker.ts";
import { voiceCatalogue } from "../src/main/tts/catalogue.ts";
import { validateSynthesis, type SynthesisRequest } from "../src/shared/channels/table-read.ts";
import { STARTER_TRANSCRIPT, STARTER_VOICES } from "../../../native/voice-helper/scripts/starter-voices.ts";

const bytes = Buffer.from("synthetic model fixture");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function pack(id = "phonon", engine: VoicePack["engine"] = "phonon"): VoicePack {
  return { id, engine, label: "Fixture", quantization: "fixture", minimumMacOS: 15, memoryGB: 8,
    license: "test-only", provenance: "Synthetic fixture, no model downloaded",
    sources: [{ repo: "test/fixture", revision: "a".repeat(40), include: ".*", strip: "", destination: "" }],
    files: [{ source: 0, path: "weights.bin", localPath: "nested/weights.bin", size: bytes.length, sha256: sha(bytes) }] };
}
const fixture = () => mkdtemp(join(tmpdir(), "voice-engines-"));
const signal = () => new AbortController().signal;
const download: typeof fetch = async () => new Response(bytes);
function wav() {
  const b = Buffer.alloc(48); b.write("RIFF"); b.writeUInt32LE(40, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(4, 40); return b;
}

test("manifests reject unresolved pins, duplicate/traversing files, invalid sizes and hashes", () => {
  validateVoicePack(pack());
  for (const bad of [
    { ...pack(), unresolved: "offline" }, { ...pack(), sources: [{ ...pack().sources[0]!, revision: "main" }] },
    { ...pack(), files: [] }, { ...pack(), files: [...pack().files, ...pack().files] },
    ...[{ localPath: "../escape" }, { path: "/absolute" }, { size: -1 }, { sha256: "bad" }].map((patch) => ({ ...pack(), files: [{ ...pack().files[0]!, ...patch }] }))
  ]) assert.throws(() => validateVoicePack(bad));
  for (const entry of VOICE_PACKS) {
    if (entry.unresolved) assert.throws(() => validateVoicePack(entry), /unresolved/);
    else validateVoicePack(entry);
  }
  assert.notEqual(packChecksum(pack()), packChecksum({ ...pack(), quantization: "other" }));
  assert.equal(performancePack(16 * 1024 ** 3), "qwen-base-06b");
  assert.equal(performancePack(32 * 1024 ** 3), "qwen-base-17b");
});

test("installer requires consent, verifies every local file, reports disk use and removes packs", async () => {
  const root = await fixture(); const manager = new VoiceModelManager(root, [pack()], download);
  try {
    await assert.rejects(manager.install("phonon", false, signal()), /Confirm/);
    const progress: number[] = [];
    await manager.install("phonon", true, signal(), (p) => progress.push(p.completedBytes));
    assert.equal(progress.at(-1), bytes.length);
    assert.deepEqual(await readFile(join(await manager.verifiedDirectory("phonon"), "nested/weights.bin")), bytes);
    const state = (await manager.states())[0]!;
    assert(state.installed); assert.equal(state.sizeBytes, bytes.length); assert.equal(state.diskBytes, bytes.length + Buffer.byteLength(noticeText(pack())));
    assert.deepEqual(state.licenseUrls, [`https://huggingface.co/test/fixture/blob/${"a".repeat(40)}/README.md`]);
    assert.equal(state.license, "test-only"); assert.equal(state.minimumMacOS, 15);
    assert.match(await readFile(join(await manager.verifiedDirectory("phonon"), "notices/NOTICE.txt"), "utf8"), /License: test-only/);
    await manager.remove("phonon"); assert(!(await manager.states())[0]!.installed);
    await assert.rejects(manager.verifiedDirectory("phonon"), /verification/);
    assert.deepEqual(await readdir(root), [], "listing states must not recreate pack folders");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("states does not create folders for packs that are not installed", async () => {
  const root = await fixture();
  try {
    const manager = new VoiceModelManager(join(root, "models"), [pack()], download);
    assert(!(await manager.states())[0]!.installed);
    await assert.rejects(readdir(join(root, "models")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pack notices carry the source license and CC BY attribution", () => {
  const phonon = VOICE_PACKS.find((p) => p.id === "phonon")!;
  assert.equal(phonon.license, "cc-by-4.0");
  assert.match(noticeText(phonon), /Attribution:.*CC BY 4\.0/);
  for (const entry of VOICE_PACKS) assert.match(noticeText(entry), new RegExp(entry.sources[0]!.repo));
});

test("checksum mismatch refuses installation and tampering refuses model load", async () => {
  const root = await fixture();
  try {
    const bad = new VoiceModelManager(root, [pack()], async () => new Response(Buffer.alloc(bytes.length)));
    await assert.rejects(bad.install("phonon", true, signal()), /checksum mismatch/);
    await assert.rejects(bad.verifiedDirectory("phonon"), /verification/);
    const good = new VoiceModelManager(root, [pack()], download);
    await good.install("phonon", true, signal());
    const directory = await good.verifiedDirectory("phonon");
    await writeFile(join(directory, "nested/weights.bin"), Buffer.alloc(bytes.length));
    await assert.rejects(good.verifiedDirectory("phonon"), /verification/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an interrupted download resumes at the retained byte offset", async () => {
  const root = await fixture(); let requests = 0;
  const fetchFile: typeof fetch = async (_url, init) => {
    requests++;
    if (requests === 1) {
      let chunks = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (chunks++ === 0) controller.enqueue(bytes.subarray(0, 4));
        else controller.error(new Error("simulated disconnect"));
      } }, { highWaterMark: 0 }));
    }
    assert.equal((init?.headers as Record<string, string>).Range, "bytes=4-");
    return new Response(bytes.subarray(4), { status: 206, headers: { "content-range": `bytes 4-${bytes.length - 1}/${bytes.length}` } });
  };
  try {
    const manager = new VoiceModelManager(root, [pack()], fetchFile);
    await assert.rejects(manager.install("phonon", true, signal()), /disconnect/);
    await manager.install("phonon", true, signal()); assert.equal(requests, 2);
    await manager.verifiedDirectory("phonon");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("range-ignorant servers restart the partial file; incorrect ranges and symlink parents fail", async () => {
  const root = await fixture(); const p = pack(); const directory = join(root, p.id, packChecksum(p));
  try {
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "nested/weights.bin.part"), bytes.subarray(0, 4));
    const manager = new VoiceModelManager(root, [p], download);
    await manager.install(p.id, true, signal()); await manager.verifiedDirectory(p.id);
    await rm(join(directory, "nested"), { recursive: true });
    await symlink(tmpdir(), join(directory, "nested"));
    await assert.rejects(manager.install(p.id, true, signal()), /Unsafe/);
    await assert.rejects(manager.verifiedDirectory(p.id), /Unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const request: Omit<SynthesisRequest, "id"> = { engine: "phonon", voice: "default", text: "Hello." };
const identity: SpeechIdentity = { engineVersion: "v1", modelChecksum: "model-a", quantization: "fp16", voiceChecksum: "voice-a" };
test("every synthesis identity component invalidates cached audio", () => {
  const key = audioKey(request, identity);
  for (const field of ["engineVersion", "modelChecksum", "quantization", "voiceChecksum"] as const) {
    assert.notEqual(key, audioKey(request, { ...identity, [field]: "changed" }), field);
  }
  for (const patch of [{ engine: "kokoro" as const }, { voice: "other" }, { text: "Goodbye." }, { direction: "quiet" },
    { pronunciations: { Hello: "hullo" } }, { generationSettings: { seed: 7 } }, { generationSettings: { temperature: 0.8 } },
    { generationSettings: { speed: 1.1 } }, { contextFingerprint: "scene-before" }]) {
    assert.notEqual(key, audioKey({ ...request, ...patch }, identity), JSON.stringify(patch));
  }
  assert.equal(key, audioKey({ ...request, text: " Hello.\r\n" }, identity));
  assert.equal(key, audioKey({ ...request, priority: "prefetch" }, identity));
  const a = { ...request, pronunciations: { Hello: "hullo", world: "werld" } };
  assert.equal(audioKey(a, identity), audioKey({ ...a, pronunciations: { world: "werld", Hello: "hullo" } }, identity));
});

class FakeWorker extends VoiceWorker {
  running = false;
  prepares = 0;
  stops = 0;
  payloads: Record<string, unknown>[] = [];
  constructor() { super("unused-test-binary"); }
  override isRunning() { return this.running; }
  override stop() { if (this.running) this.stops++; this.running = false; }
  override async request(payload: Record<string, unknown>, abort: AbortSignal) {
    abort.throwIfAborted(); this.payloads.push(payload); this.running = true;
    if (payload.op === "prepare") { this.prepares++; assert.equal(typeof payload.directory, "string"); return { voices: ["default"] }; }
    return { audio: wav().toString("base64") };
  }
}
async function installedRuntime(idleMs = 1000) {
  const root = await fixture(), worker = new FakeWorker(); let network = 0;
  const packs = [pack(), pack("kokoro", "kokoro"), pack("qwen-base-06b", "qwen"), pack("qwen-design", "qwen-design")];
  const models = new VoiceModelManager(join(root, "models"), packs, async () => { network++; return new Response(bytes); });
  for (const p of packs) await models.install(p.id, true, signal());
  const baseline = network;
  const runtime = new ReaderRuntime({ root, worker, models, idleMs, platform: "test", memoryBytes: 8 * 1024 ** 3 });
  return { root, worker, runtime, network: () => network - baseline };
}

test("installed synthesis and engine reloads stay offline, warm once, release on idle/pressure, and switch models", async () => {
  const f = await installedRuntime(30);
  try {
    await f.runtime.prepare("phonon", true);
    await f.runtime.synthesize({ ...request, id: "one" });
    assert((await f.runtime.synthesize({ ...request, id: "two" })).cached);
    assert.equal(f.worker.prepares, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert(!f.worker.running);
    await f.runtime.synthesize({ ...request, id: "three", text: "New text" });
    assert.equal(f.worker.prepares, 2);
    await f.runtime.prepare("kokoro", true);
    assert.equal(f.worker.prepares, 3); assert(f.worker.stops >= 2);
    f.runtime.memoryPressure(); assert(!f.worker.running);
    await f.runtime.synthesize({ ...request, engine: "kokoro", id: "four", text: "After pressure" });
    assert.equal(f.worker.prepares, 4);
    assert.equal(f.network(), 0, "no model downloads or inference-network calls after installation");
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("typing/dictation hints defer only prefetch and validate input", async () => {
  const f = await installedRuntime();
  try {
    await f.runtime.prepare("phonon", true);
    assert.throws(() => f.runtime.activity({ typing: "yes", dictating: false }));
    f.runtime.activity({ typing: true, dictating: false });
    await assert.rejects(f.runtime.synthesize({ ...request, id: "prefetch", priority: "prefetch" }), /Prefetch paused/);
    await f.runtime.synthesize({ ...request, id: "foreground" });
    f.runtime.activity({ typing: false, dictating: true });
    await assert.rejects(f.runtime.synthesize({ ...request, id: "prefetch2", priority: "prefetch" }), /Prefetch paused/);
    f.runtime.activity({ typing: false, dictating: false });
    await f.runtime.synthesize({ ...request, id: "prefetch3", priority: "prefetch" });
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("designed voices persist exact references and Base reuses them for every line", async () => {
  const f = await installedRuntime();
  try {
    const v = await f.runtime.designVoice({ label: "Test voice", description: "Warm adult alto", transcript: "Exact reference words.",
      tags: ["feminine", "adult", "American English", "warm"], provenance: "Synthetic test fixture" });
    const { reference, audioPath } = await f.runtime.references.get(v.id);
    assert.equal(reference.transcript, "Exact reference words."); assert(reference.generatorVersion);
    assert.equal(reference.audioChecksum, sha(wav()));
    await f.runtime.prepare("qwen", true);
    for (const [i, text] of ["First line", "Second line"].entries()) await f.runtime.synthesize({ id: `line-${i}`, engine: "qwen", voice: v.id, text });
    assert.equal(f.worker.payloads.filter((p) => p.op === "design").length, 1);
    for (const p of f.worker.payloads.filter((p) => p.op === "synthesize")) {
      assert.equal(p.referencePath, audioPath); assert.equal(p.referenceText, reference.transcript);
    }
    assert.equal((await f.runtime.voiceCatalogue()).find((voice) => voice.id === v.id)?.checksum, referenceChecksum(reference));
    await writeFile(audioPath, Buffer.alloc(wav().length));
    await assert.rejects(f.runtime.references.get(v.id), /verification/);
    await assert.rejects(f.runtime.synthesize({ id: "bad-ref", engine: "qwen", voice: v.id, text: "Bad reference" }), /verification/);
    assert.equal(f.network(), 0);
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("reference identities cannot be overwritten and reference metadata changes invalidate audio", async () => {
  const root = await fixture(); const bank = new ReferenceBank(root);
  const draft = { id: "test", label: "Test", transcript: "Exact.", description: "Soft", tags: ["soft"], provenance: "Synthetic", generatorVersion: "v1", modelChecksum: "model" };
  try {
    const saved = await bank.save(draft, wav()); await assert.rejects(bank.save(draft, wav()), /already exists/);
    assert.notEqual(referenceChecksum(saved), referenceChecksum({ ...saved, transcript: "Changed." }));
    assert.notEqual(referenceChecksum(saved), referenceChecksum({ ...saved, generatorVersion: "v2" }));
    assert.equal((await bank.list()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("catalogues annotate installed voices only; starter bank has sixteen distinct recipes", () => {
  const list = voiceCatalogue({ system: [{ id: "Samantha", label: "Samantha", language: "en-US" }], ming: [{ id: "UK_George", label: "George", language: "en-GB" }], phonon: [{ id: "default", label: "Default", language: "en" }] });
  assert.equal(list.length, 3); assert(list.every((v) => v.engine && v.tags && v.tags.length >= 4));
  assert(list[0]!.tags!.includes("feminine")); assert(list[1]!.tags!.includes("British English"));
  assert.equal(STARTER_VOICES.length, 16); assert.equal(new Set(STARTER_VOICES.map((v) => v[1])).size, 16);
  assert(STARTER_TRANSCRIPT.length > 100);
});

test("new IPC synthesis fields reject malformed settings and unbounded metadata", () => {
  const valid = { ...request, id: "valid" };
  for (const patch of [{ priority: "whatever" }, { direction: 3 }, { contextFingerprint: "x".repeat(201) },
    { pronunciations: [] }, { pronunciations: { hello: 3 } }, { generationSettings: { seed: -1 } },
    { generationSettings: { temperature: 2 } }, { generationSettings: { speed: 99 } }, { generationSettings: { network: true } }]) {
    assert.throws(() => validateSynthesis({ ...valid, ...patch }));
  }
});

test("wrong resumed ranges never become usable models", async () => {
  const root = await fixture(), p = pack();
  const directory = join(root, p.id, packChecksum(p));
  try {
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "nested/weights.bin.part"), bytes.subarray(0, 4));
    const manager = new VoiceModelManager(root, [p], async () => new Response(bytes.subarray(4), {
      status: 206, headers: { "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}` }
    }));
    await assert.rejects(manager.install(p.id, true, signal()), /Invalid voice download range/);
    await assert.rejects(manager.verifiedDirectory(p.id), /verification/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the native worker sandbox denies inference-time HTTP connections", async (t) => {
  if (process.platform !== "darwin") { t.skip("macOS sandbox-exec only"); return; }
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", "/usr/bin/true"]);
  if (probe.status !== 0) { t.skip("Host sandbox prevents sandbox-exec; run on the macOS CI host"); return; }
  const { createServer } = await import("node:http");
  const { chmod } = await import("node:fs/promises");
  let connections = 0;
  const server = createServer((_req, res) => { connections++; res.end("network must not be reached"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const root = await fixture(), script = join(root, "offline-probe.mjs");
  const address = server.address(); assert(address && typeof address !== "string");
  await writeFile(script, `#!${process.execPath}\nimport http from "node:http";\nimport readline from "node:readline";\nfor await (const line of readline.createInterface({input: process.stdin})) {\n const r = JSON.parse(line);\n const reply = (denied) => process.stdout.write(JSON.stringify({id:r.id,ok:true,networkDenied:denied})+"\\n");\n const req = http.get("http://127.0.0.1:${address.port}", () => reply(false));\n req.on("error", () => reply(true)); req.setTimeout(2000, () => req.destroy(new Error("timeout")));\n}\n`);
  await chmod(script, 0o700);
  const worker = new VoiceWorker(script);
  try {
    const result = await worker.request({ op: "synthesize", engine: "fixture" }, signal(), 5000);
    assert.equal(result.networkDenied, true); assert.equal(connections, 0);
  } finally { worker.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("manifest generation pins API revisions, follows listings, hashes small files and preserves notices", async () => {
  const { resolveVoiceManifest } = await import("../src/main/models/voice-manifest-builder.ts");
  const pending = { ...pack(), files: [], unresolved: "offline", sources: [{ ...pack().sources[0]!, revision: "UNRESOLVED", include: "\\.bin$" }] };
  const fetched: string[] = [];
  const commit = "b".repeat(40);
  const fetchFile: typeof fetch = async (input) => {
    const url = String(input); fetched.push(url);
    if (url.endsWith("/revision/main")) return Response.json({ sha: commit, cardData: { license: "test-only" } });
    if (url.includes("/tree/")) return Response.json([
      { type: "file", path: "weights.bin", size: bytes.length, lfs: { size: bytes.length, oid: sha(bytes) } },
      { type: "directory", path: "ignored.bin", size: 0 }
    ], { headers: { link: '<https://huggingface.co/next-page>; rel="next"' } });
    if (url.endsWith("/next-page")) return Response.json([{ type: "file", path: "LICENSE", size: 4 }]);
    if (url.endsWith("/LICENSE")) return new Response("Test");
    throw new Error(`Unexpected URL: ${url}`);
  };
  const [resolved] = await resolveVoiceManifest([pending], fetchFile);
  validateVoicePack(resolved!);
  assert.equal(resolved!.sources[0]!.revision, commit);
  assert.equal(resolved!.sources[0]!.license, "test-only");
  assert.equal(resolved!.files[1]!.localPath, "notices/source-0/LICENSE");
  assert.equal(resolved!.files[1]!.sha256, sha(Buffer.from("Test")));
  assert(fetched.some((url) => url.includes(`/tree/${commit}?`)));
  assert(fetched.some((url) => url.includes(`/resolve/${commit}/LICENSE`)));
  assert(!fetched.some((url) => url.endsWith("weights.bin")), "LFS SHA-256 needs no full model download");
  assert.equal(pending.sources[0]!.revision, "UNRESOLVED", "failed/unfinished generation never mutates the input manifest");
  await assert.rejects(resolveVoiceManifest([pending], async () => new Response("no", { status: 404 })), /revision unavailable/);
});

test("unmanifested weights cannot enter a local model load", async () => {
  const root = await fixture(), manager = new VoiceModelManager(root, [pack()], download);
  try {
    await manager.install("phonon", true, signal());
    const directory = await manager.verifiedDirectory("phonon");
    await writeFile(join(directory, "unexpected.safetensors"), bytes);
    await assert.rejects(manager.verifiedDirectory("phonon"), /Unverified voice model asset/);
    assert.equal((await manager.states())[0]!.installed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("catalogue discovery enumerates installed packs without warming any engine", async () => {
  const root = await fixture(), worker = new FakeWorker();
  const phonon = pack();
  phonon.files = ["default", "en_us_Juniper", "fr_Camille"].map((name) => ({
    ...phonon.files[0]!, path: `voices/${name}.safetensors`, localPath: `voices/${name}.safetensors`
  }));
  const kokoro = pack("kokoro", "kokoro");
  kokoro.files = [{ ...kokoro.files[0]!, path: "voices/af_heart.json", localPath: "kokoro/voices/af_heart.json" }];
  const models = new VoiceModelManager(join(root, "models"), [phonon, kokoro, pack("ming", "ming")], download);
  const runtime = new ReaderRuntime({ root, models, worker, platform: "test" });
  try {
    for (const p of models.packs) await models.install(p.id, true, signal());
    const catalogue = await runtime.voiceCatalogue();
    assert.deepEqual(catalogue.filter((v) => v.engine === "phonon").map((v) => v.id), ["default", "en_us_Juniper"]);
    assert.equal(catalogue.find((v) => v.engine === "kokoro")?.id, "af_heart");
    assert.equal(catalogue.filter((v) => v.engine === "ming").length, 3);
    assert.equal(worker.prepares, 0);
    await models.remove("kokoro");
    assert(!(await runtime.voiceCatalogue()).some((v) => v.engine === "kokoro"));
  } finally { runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("unsupported acting controls and VoiceDesign line playback fail before generation", async () => {
  const f = await installedRuntime();
  try {
    await f.runtime.prepare("phonon", true);
    await assert.rejects(f.runtime.synthesize({ ...request, id: "acting", direction: "whisper" }), /does not support/);
    await assert.rejects(f.runtime.synthesize({ ...request, id: "speed", generationSettings: { speed: 1.2 } }), /Unsupported/);
    await assert.rejects(f.runtime.synthesize({ ...request, engine: "qwen-design", id: "design-line" }), /Design a reference once/);
    assert.equal(f.worker.payloads.filter((p) => p.op === "synthesize").length, 0);
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("install identity ignores requirements and notice metadata but follows the assets", () => {
  const base = packChecksum(pack());
  for (const patch of [{ memoryGB: 24 }, { license: "cc-by-4.0" }, { label: "Renamed" }, { provenance: "Reworded" }, { minimumMacOS: 16 }]) {
    assert.equal(packChecksum({ ...pack(), ...patch }), base, JSON.stringify(patch));
  }
  const changed = pack();
  assert.notEqual(packChecksum({ ...changed, files: [{ ...changed.files[0]!, sha256: sha(Buffer.from("other")) }] }), base);
  assert.notEqual(packChecksum({ ...changed, sources: [{ ...changed.sources[0]!, revision: "b".repeat(40) }] }), base);
});

test("a pack installed under an older folder name is recognized in place, with its notice refreshed, without downloading", async () => {
  const root = await fixture(); const p = pack();
  try {
    await new VoiceModelManager(root, [p], download).install(p.id, true, signal());
    const legacy = join(root, p.id, "f".repeat(64));
    await rename(join(root, p.id, packChecksum(p)), legacy);
    await rm(join(legacy, "notices"), { recursive: true });
    const refused: typeof fetch = async () => { throw new Error("must not download"); };
    const manager = new VoiceModelManager(root, [{ ...p, license: "cc-by-4.0", memoryGB: 24 }], refused);
    assert.equal((await manager.states())[0]!.installed, true);
    const directory = await manager.verifiedDirectory(p.id);
    assert.equal(directory, join(root, p.id, packChecksum(p)));
    assert.match(await readFile(join(directory, "notices/NOTICE.txt"), "utf8"), /cc-by-4\.0/);
    assert.deepEqual(await readdir(join(root, p.id)), [packChecksum(p)]);
    // Changed weights are still refused.
    await writeFile(join(directory, "nested/weights.bin"), "tampered fixture byte");
    await assert.rejects(manager.verifiedDirectory(p.id), /verification/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a symlinked pack folder is refused before any folder inside it is renamed", async () => {
  const root = await fixture(), outside = await fixture(); const p = pack();
  try {
    await new VoiceModelManager(outside, [p], download).install(p.id, true, signal());
    const external = join(outside, p.id);
    const hashed = join(external, "e".repeat(64));
    await rename(join(external, packChecksum(p)), hashed);
    await symlink(external, join(root, p.id));
    const manager = new VoiceModelManager(root, [p], async () => { throw new Error("must not download"); });
    assert.equal((await manager.states())[0]!.installed, false);
    assert.deepEqual(await readdir(external), ["e".repeat(64)], "the external folder was not touched");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("concurrent verifications of a pack with a missing notice all succeed", async () => {
  const root = await fixture(); const p = pack();
  try {
    const manager = new VoiceModelManager(root, [p], download);
    await manager.install(p.id, true, signal());
    for (let round = 0; round < 20; round++) {
      await rm(join(root, p.id, packChecksum(p), "notices"), { recursive: true, force: true });
      const others = [new VoiceModelManager(root, [p], download), new VoiceModelManager(root, [p], download)];
      const results = await Promise.allSettled([manager, ...others, manager].map((m) => m.verifiedDirectory(p.id)));
      assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled"], String((results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined)?.reason));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preview, regenerate, discard and keep preserve immutable references and provenance", async () => {
  const f = await installedRuntime();
  const input = { label: "MAYA", description: "Gravelly adult alto", transcript: "Exact reference words.", tags: [], provenance: "VoiceDesign reference voice. Private; do not share." };
  try {
    const first = await f.runtime.designVoice(input, true);
    assert.deepEqual(new Uint8Array(first.audio!), new Uint8Array(wav()));
    assert.equal((await f.runtime.references.list()).length, 0);
    const second = await f.runtime.designVoice(input, true);
    await assert.rejects(f.runtime.keepDesign(first.id), /another audition/);
    await f.runtime.discardDesign();
    await assert.rejects(f.runtime.keepDesign(second.id), /another audition/);
    const third = await f.runtime.designVoice(input, true);
    const kept = await f.runtime.keepDesign(third.id);
    assert.equal(kept.id, third.id);
    await f.runtime.bindDesign(kept.id);
    assert.equal((await f.runtime.references.list()).length, 1);
    assert.equal((await f.runtime.references.get(kept.id)).reference.provenance, input.provenance);
    await assert.rejects(f.runtime.keepDesign(third.id), /another audition/);
    const cancelled = await f.runtime.designVoice(input, true);
    f.runtime.cancel();
    await assert.rejects(f.runtime.keepDesign(cancelled.id), /another audition/);
    assert.equal(f.network(), 0);
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("low memory needs consent and consent permits a later model load", async () => {
  const f = await installedRuntime();
  try {
    f.runtime.models.pack("phonon").memoryGB = 16;
    assert.throws(() => f.runtime.checkRequirements("phonon"), /16 GB/);
    f.runtime.checkRequirements("phonon", true);
    await f.runtime.prepare("phonon", true);
    assert.equal((await f.runtime.status()).memoryGB, 8);
    assert.equal(f.network(), 0);
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("removing the last Qwen Base pack clears playback readiness", async () => {
  const f = await installedRuntime();
  try {
    await f.runtime.prepare("qwen", true);
    assert((await f.runtime.status()).engines.find((e) => e.id === "qwen")!.ready);
    f.runtime.releaseModel(); await f.runtime.models.remove("qwen-base-06b");
    assert.equal((await f.runtime.status()).engines.find((e) => e.id === "qwen")!.ready, false);
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("loading from the UI never repairs an absent or corrupt pack through an unconfirmed download", async () => {
  const f = await installedRuntime();
  try {
    const directory = await f.runtime.models.verifiedDirectory("phonon");
    await writeFile(join(directory, "nested/weights.bin"), Buffer.alloc(bytes.length));
    await assert.rejects(f.runtime.prepare("phonon", true, undefined, undefined, true), /failed verification/);
    assert.equal(f.network(), 0);
    await f.runtime.models.remove("phonon");
    await assert.rejects(f.runtime.prepare("phonon", true, undefined, undefined, true), /missing/);
    assert.equal(f.network(), 0);
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("Base variant changes invalidate readiness and require a fresh model load", async () => {
  const f = await installedRuntime();
  try {
    await f.runtime.status(); await f.runtime.prepare("qwen", true);
    await f.runtime.models.remove("qwen-base-06b");
    const large = pack("qwen-base-17b", "qwen"); f.runtime.models.packs.push(large);
    await f.runtime.models.install(large.id, true, signal());
    assert.equal((await f.runtime.status()).engines.find((e) => e.id === "qwen")!.ready, false);
    const prepares = f.worker.prepares;
    await f.runtime.prepare("qwen", true, undefined, undefined, true);
    assert.equal(f.worker.prepares, prepares + 1);
    assert.match(String(f.worker.payloads.findLast((p) => p.op === "prepare")!.directory), /qwen-base-17b/);
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});


test("remove holds the install lock until deletion completes and releases it afterward", async () => {
  const root = await fixture(), manager = new VoiceModelManager(root, [pack()], download);
  try {
    await manager.install("phonon", true, signal());
    const removing = manager.remove("phonon");
    const blocked = assert.rejects(manager.install("phonon", true, signal()), /already being changed/);
    const second = assert.rejects(manager.remove("phonon"), /already being changed/);
    await Promise.all([removing, blocked, second]);
    await manager.install("phonon", true, signal());
    await manager.verifiedDirectory("phonon");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("memory consent belongs to the exact Qwen variant shown in the warning", async () => {
  const f = await installedRuntime();
  try {
    const small = f.runtime.models.pack("qwen-base-06b"); small.memoryGB = 16;
    const large = { ...pack("qwen-base-17b", "qwen"), memoryGB: 24 };
    f.runtime.models.packs.push(large);
    await f.runtime.models.install(large.id, true, signal());
    await f.runtime.status();
    await f.runtime.models.remove(small.id);
    await assert.rejects(f.runtime.prepare("qwen", true, undefined, small.id, true), /pack changed/);
    assert.equal(f.worker.prepares, 0);
    await assert.rejects(f.runtime.prepare("qwen", true, undefined, undefined, true), /24 GB/);
    await f.runtime.prepare("qwen", true, undefined, large.id, true);
    assert.match(String(f.worker.payloads.at(-1)!.directory), /qwen-base-17b/);
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

const designInput = { label: "MAYA", description: "Gravelly adult alto", transcript: "Exact words.", tags: [], provenance: "Private; do not share." };
test("cancelling during binding never deletes a reference already visible to another window", async () => {
  const f = await installedRuntime();
  const save = f.runtime.references.save.bind(f.runtime.references);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  f.runtime.references.save = async (reference, audio) => {
    const saved = await save(reference, audio);
    started.resolve(); await finish.promise; return saved;
  };
  try {
    const preview = await f.runtime.designVoice(designInput, true);
    const voice = await f.runtime.keepDesign(preview.id);
    const binding = f.runtime.bindDesign(voice.id);
    await started.promise;
    const otherBank = new ReferenceBank(f.runtime.references.root);
    assert.equal((await otherBank.list())[0]!.id, voice.id);
    f.runtime.cancel();
    const discarding = f.runtime.discardDesign();
    finish.resolve(); await binding; await discarding;
    assert.equal((await otherBank.get(voice.id)).reference.id, voice.id);
  } finally { finish.resolve(); await f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("discard cleans up a saved design until binding is acknowledged", async () => {
  const f = await installedRuntime();
  try {
    const preview = await f.runtime.designVoice(designInput, true);
    await f.runtime.keepDesign(preview.id);
    await f.runtime.discardDesign();
    assert.deepEqual(await f.runtime.references.list(), []);
    const next = await f.runtime.designVoice(designInput, true);
    const voice = await f.runtime.keepDesign(next.id);
    await assert.rejects(f.runtime.bindDesign("other-window-reference"), /no longer pending/);
    await f.runtime.bindDesign(voice.id);
    f.runtime.cancel(); await f.runtime.discardDesign();
    assert.equal((await f.runtime.references.list())[0]!.id, voice.id);
  } finally { f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("reference saves refuse cancellation before committing files", async () => {
  const root = await fixture(), bank = new ReferenceBank(root), abort = new AbortController();
  try {
    abort.abort();
    await assert.rejects(bank.save({ id: "cancelled", ...designInput, generatorVersion: "test", modelChecksum: "test" }, wav(), abort.signal), /abort/i);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pack invalidation clears warm readiness before the next status refresh", async () => {
  const f = await installedRuntime();
  const other = new ReaderRuntime({ root: f.root, models: f.runtime.models, worker: new FakeWorker(), platform: "test" });
  try {
    for (const runtime of [f.runtime, other]) await runtime.prepare("phonon", true);
    await f.runtime.models.remove("phonon");
    for (const runtime of [f.runtime, other]) {
      runtime.invalidatePack("phonon");
      await assert.rejects(runtime.synthesize({ ...request, id: "after-remove" }), /Load the selected/);
      assert.equal((await runtime.status()).engines.find((e) => e.id === "phonon")!.ready, false);
    }
  } finally { f.runtime.dispose(); other.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

test("provisional designs stay outside every window's reference bank and catalogue until bound", async () => {
  const f = await installedRuntime();
  const other = new ReaderRuntime({ root: f.root, models: f.runtime.models, references: f.runtime.references,
    worker: new FakeWorker(), platform: "test" });
  try {
    const preview = await f.runtime.designVoice(designInput, true);
    const kept = await f.runtime.keepDesign(preview.id);
    assert.deepEqual(await other.voiceCatalogue(), []);
    assert.deepEqual(await other.references.list(), []);
    await assert.rejects(other.references.get(kept.id), /ENOENT/);
    await other.prepare("qwen", true);
    await assert.rejects(other.synthesize({ id: "eli", engine: "qwen", voice: kept.id, text: "Wait here." }), /catalogue/);
    await f.runtime.discardDesign();
    assert.deepEqual(await other.references.list(), []);

    const next = await f.runtime.designVoice(designInput, true);
    const voice = await f.runtime.keepDesign(next.id);
    await f.runtime.bindDesign(voice.id);
    assert((await other.voiceCatalogue()).some((v) => v.id === voice.id));
    await f.runtime.discardDesign();
    await other.synthesize({ id: "eli-bound", engine: "qwen", voice: voice.id, text: "Wait here." });
    assert.equal((await other.references.get(voice.id)).reference.id, voice.id);
  } finally { await f.runtime.dispose(); await other.dispose(); await rm(f.root, { recursive: true, force: true }); }
});


test("runtime disposal waits for an aborted speech job to remove its temporary audio", async () => {
  const root = await fixture();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let audioPath = "";
  const runtime = new ReaderRuntime({ root, platform: "darwin", systemRun: async (args, _text, abort) => {
    if (args[1] === "?") return "Fixture (Premium) en_US # Test voice";
    audioPath = args[args.indexOf("-o") + 1]!;
    await writeFile(audioPath, wav());
    started.resolve(); await finish.promise;
    abort.throwIfAborted(); return "";
  } });
  try {
    await runtime.prepare("system", true);
    const speaking = runtime.synthesize({ id: "closing", engine: "system", voice: "Fixture (Premium)", text: "Wait here." });
    const cancelled = assert.rejects(speaking, /abort/i);
    await started.promise;
    let disposed = false;
    const disposing = Promise.resolve(runtime.dispose()).then(() => { disposed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.deepEqual(await readFile(audioPath), wav());
    finish.resolve(); await cancelled; await disposing;
    await assert.rejects(readFile(audioPath), /ENOENT/);
  } finally { finish.resolve(); await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
