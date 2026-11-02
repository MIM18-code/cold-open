import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir, release, totalmem } from "node:os";
import { join } from "node:path";
import { normalizeWave } from "./loudness.ts";
import { isReadEngine, type ReadEngine, type ReadVoice, type ReaderStatus, type SynthesisRequest, type SynthesisResult, type VoicePackState } from "../../shared/channels/table-read.ts";
import { openForRead, replaceFile } from "../safe-fs.ts";
import { VoiceWorker } from "./worker.ts";
import { audioKey, ENGINE_VERSION, normalizedSpeech, type SpeechIdentity } from "./cache-key.ts";
import { VoiceModelManager, type InstallProgress } from "../models/voice-manager.ts";
import { voiceTags } from "./voice-gender.ts";
import { VOICE_PACKS, packChecksum, performancePack } from "../models/voice-manifest.ts";
import { voiceCatalogue } from "./catalogue.ts";
import { ReferenceBank, referenceChecksum } from "./reference-bank.ts";
export { audioKey } from "./cache-key.ts";
const LIMIT = 256 * 1024 * 1024, MAX_AUDIO = 16 * 1024 * 1024;
export function validWave(data: Uint8Array): boolean {
  const b = Buffer.from(data);
  if (b.length < 44 || b.length > MAX_AUDIO || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE" || b.readUInt32LE(4) + 8 > b.length) return false;
  let format = false, samples = false;
  for (let i = 12; i + 8 <= b.length;) {
    const name = b.toString("ascii", i, i + 4), size = b.readUInt32LE(i + 4), end = i + 8 + size;
    if (end > b.length) return false;
    if (name === "fmt ") {
      if (size < 16) return false;
      const codec = b.readUInt16LE(i + 8), channels = b.readUInt16LE(i + 10), rate = b.readUInt32LE(i + 12), bits = b.readUInt16LE(i + 22);
      format = (codec === 1 && bits === 16 || codec === 3 && bits === 32) && (channels === 1 || channels === 2) && rate >= 8000 && rate <= 192000;
    }
    if (name === "data") samples = size > 0;
    i = end + (size % 2);
  }
  return format && samples;
}
// Only Apple's Premium and Enhanced voices: the older built-in ones (Fred, Eddy, Grandpa, the sound effects) sound
// robotic next to the voice packs, which is what the table read exists to avoid.
export function parseSystemVoices(output: string): ReadVoice[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^(.+?)\s+([a-z]{2,3}_[A-Z]{2})\s+#/.exec(line);
    if (!match || !/\((?:Premium|Enhanced)\)/.test(match[1]!)) return [];
    const id = match[1]!.trim();
    const tags = voiceTags("system", id);
    return [{ id, label: id, language: match[2]!.replace("_", "-"), ...(tags ? { tags } : {}) }];
  });
}
export function runSay(args: string[], input: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/say", args, { stdio: ["pipe", "pipe", "pipe"] }); let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("The system voice timed out.")); }, 90_000);
    const abort = () => { child.kill("SIGKILL"); reject(new Error("Speech job cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (b) => { out += String(b); if (out.length > 200_000) { child.kill(); reject(new Error("Unexpected voice response.")); } });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); signal.removeEventListener("abort", abort); code === 0 ? resolve(out) : reject(new Error("The selected system voice could not speak. Choose another installed voice.")); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
export interface ReaderRuntimeOptions {
  root: string;
  helper?: string;
  platform?: string;
  systemRun?: typeof runSay;
  worker?: VoiceWorker;
  models?: VoiceModelManager;
  references?: ReferenceBank;
  idleMs?: number;
  memoryBytes?: number;
  beforeLoad?: () => void;
}
type PendingDesign = { reference: Parameters<ReferenceBank["save"]>[0]; audio: Uint8Array };
export class ReaderRuntime {
  private readonly worker?: VoiceWorker;
  readonly models: VoiceModelManager;
  readonly references: ReferenceBank;
  private readonly idleMs: number;
  private readonly memoryBytes: number;
  private readonly beforeLoad?: () => void;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private activityUntil = 0;
  private dictating = false;
  private readonly memoryApproved = new Set<string>();
  private pendingDesign?: PendingDesign;
  private savedDesign?: PendingDesign;
  private qwenPack?: string;
  private activePack?: string;
  private readonly identities = new Map<ReadEngine, SpeechIdentity>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly jobs = new Map<string, AbortController>();
  private voices: Partial<Record<ReadEngine, ReadVoice[]>> = {};
  private ready = new Set<ReadEngine>();
  private activeEngine: ReadEngine | null = null;
  private readonly root: string;
  private readonly platform: string;
  private readonly systemRun: typeof runSay;
  constructor(options: ReaderRuntimeOptions) {
    this.models = options.models ?? new VoiceModelManager(join(options.root, "models"), VOICE_PACKS);
    this.references = options.references ?? new ReferenceBank(join(options.root, "references"));
    this.idleMs = options.idleMs ?? 120_000;
    this.memoryBytes = options.memoryBytes ?? totalmem(); this.beforeLoad = options.beforeLoad;
    this.root = options.root; this.platform = options.platform ?? process.platform; this.systemRun = options.systemRun ?? runSay;
    this.worker = options.worker ?? (options.helper && existsSync(options.helper) ? new VoiceWorker(options.helper) : undefined);
  }
  private enqueue<T>(id: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.jobs.has(id)) return Promise.reject(new Error("That speech request is already running."));
    if (this.jobs.size >= 4) return Promise.reject(new Error("Too many speech requests. Stop playback and retry."));
    clearTimeout(this.idleTimer);
    const abort = new AbortController(); this.jobs.set(id, abort);
    const result = this.tail.catch(() => {}).then(() => { abort.signal.throwIfAborted(); return task(abort.signal); });
    this.tail = result.catch(() => {});
    return result.finally(() => {
      this.jobs.delete(id);
      if (!this.jobs.size) {
        this.idleTimer = setTimeout(() => this.releaseModel(), this.idleMs);
        this.idleTimer.unref();
      }
    });
  }
  cancel(): void {
    this.pendingDesign = undefined;
    const busy = this.jobs.size > 0;
    for (const job of this.jobs.values()) job.abort();
    // Keep an idle model warm between auditions. An in-flight native call is killed promptly.
    if (busy) { this.worker?.stop(); this.activeEngine = null; }
  }
  releaseModel(): void {
    clearTimeout(this.idleTimer); this.worker?.stop(); this.activeEngine = null; this.activePack = undefined;
  }
  invalidatePack(id: string): void {
    const engine = this.models.pack(id).engine;
    this.ready.delete(engine); this.identities.delete(engine); this.memoryApproved.delete(id);
    if (this.activePack === id) this.releaseModel();
  }
  isBusy(): boolean { return this.jobs.size > 0; }
  memoryPressure(): void { this.cancel(); this.releaseModel(); }
  activity(input: unknown): void {
    const hint = input as { typing?: boolean; dictating?: boolean } | null;
    if (!hint || typeof hint !== "object" || typeof hint.typing !== "boolean" || typeof hint.dictating !== "boolean") throw new Error("Invalid writer activity hint.");
    this.activityUntil = hint.typing ? Date.now() + 1500 : 0; this.dictating = hint.dictating;
  }
  get prefetchPaused(): boolean { return this.dictating || Date.now() < this.activityUntil; }
  dispose(): Promise<void> { this.cancel(); this.releaseModel(); return this.discardDesign().finally(() => this.releaseModel()); }
  private packId(engine: ReadEngine): string { return engine === "qwen" ? this.qwenPack ?? performancePack(this.memoryBytes) : engine; }
  private systemScannedAt = 0;
  private async refreshCatalogue(models: VoicePackState[]): Promise<void> {
    // Rescanned (at most every 10 s) until a voice turns up, so a Premium voice added in System Settings appears
    // without a restart.
    if (this.platform === "darwin" && !this.voices.system?.length && Date.now() - this.systemScannedAt > 10_000) {
      this.systemScannedAt = Date.now();
      this.voices.system = parseSystemVoices(await this.systemRun(["-v", "?"], "", new AbortController().signal));
      if (this.voices.system.length) this.ready.add("system");
    }
    for (const engine of ["phonon", "ming", "kokoro"] as const) {
      if (!models.some((m) => m.engine === engine && m.installed)) { delete this.voices[engine]; this.ready.delete(engine); }
    }
    for (const state of models.filter((m) => m.installed)) {
      const pack = this.models.pack(state.id);
      if (pack.engine === "qwen" || pack.engine === "qwen-design" || this.voices[pack.engine]) continue;
      const ids = pack.engine === "ming" ? ["US_Emma", "UK_George", "UK_Charlotte"] : pack.files.flatMap((file) => {
        const match = pack.engine === "kokoro" ? /(?:voices\/|ANE\/)([ab][fm]_[\w]+)\.(?:json|bin)$/.exec(file.path)
          : /(?:voices|constants_bin)\/([^/]+)\.safetensors$/.exec(file.path);
        return match ? [match[1]!] : [];
      });
      this.voices[pack.engine] = [...new Set(ids)]
        .filter((id) => pack.engine !== "phonon" || id.startsWith("en_") || id.startsWith("characters_") || id === "default")
        .sort().map((id) => {
          const tags = voiceTags(pack.engine, id);
          return { id, label: id.replaceAll("_", " "), language: /^(bf|bm)_|(?:gb|UK)_/.test(id) ? "en-GB" : "en-US", ...(tags ? { tags } : {}) };
        });
    }
    if (!models.some((m) => m.engine === "qwen" && m.installed)) this.ready.delete("qwen");
    const previousQwenPack = this.qwenPack;
    this.qwenPack = models.find((m) => m.id === performancePack(this.memoryBytes) && m.installed)?.id
      ?? models.find((m) => m.engine === "qwen" && m.installed)?.id;
    if (previousQwenPack && previousQwenPack !== this.qwenPack) this.ready.delete("qwen");
    const refs = await this.references.list();
    this.voices.qwen = refs.map((r) => ({ id: r.id, label: r.label, language: "en", tags: r.tags, checksum: referenceChecksum(r) }));
  }
  async voiceCatalogue(): Promise<ReadVoice[]> {
    await this.refreshCatalogue(await this.models.states());
    return voiceCatalogue(this.voices);
  }
  private async directory(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The speech cache directory is not safe to use.");
  }
  async cacheInfo(prune = false): Promise<number> {
    await this.directory();
    const entries = await readdir(this.root); const files: { name: string; size: number; time: number }[] = [];
    for (const name of entries) if (/^[a-f0-9]{64}\.wav$/.test(name)) {
      const info = await lstat(join(this.root, name)).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) files.push({ name, size: info.size, time: info.mtimeMs });
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    if (prune) for (const file of files.sort((a, b) => a.time - b.time)) { if (total <= LIMIT) break; await rm(join(this.root, file.name), { force: true }); total -= file.size; }
    return total;
  }
  async clearCache(): Promise<void> {
    if (this.jobs.size) throw new Error("Stop playback before clearing cached audio.");
    await this.directory();
    for (const name of await readdir(this.root)) if (/^[a-f0-9]{64}\.wav$/.test(name)) await rm(join(this.root, name), { force: true });
  }
  async status(): Promise<ReaderStatus> {
    if (this.activeEngine && !this.worker?.isRunning()) this.activeEngine = null;
    const modelAvailable = this.platform === "darwin" && process.arch === "arm64" && Number(release().split(".")[0]) >= 24 && !!this.worker;
    const models = await this.models.states();
    await this.refreshCatalogue(models);
    const engines = ([
      ["phonon", "Phonon 31m", "Quick Read"], ["kokoro", "Kokoro 82M", "Quick Read"],
      ["system", "Apple Premium voices", "Built in"], ["ming", "Ming 3.0 · 0.5B", "Local presets"],
      ["qwen", "Qwen3-TTS Base", "Performance"]
    ] as const).map(([id, label, tier]) => {
      const pack = models.find((m) => m.id === this.packId(id));
      const available = id === "system" ? this.platform === "darwin" : modelAvailable && !pack?.unresolved;
      return { id, label, tier, available, ready: this.ready.has(id),
        note: id === "system" ? (this.voices.system?.length ? "Apple's Premium and Enhanced voices installed on this Mac."
          : "No Premium or Enhanced voices are installed. Add them in System Settings > Accessibility > Spoken Content > System Voice > Manage Voices.") : !available
          ? "Requires Apple silicon, macOS 15+, and the bundled voice helper."
          : pack?.unresolved ?? `${Math.round((pack?.sizeBytes ?? 0) / 1e6)} MB download · needs ${pack?.memoryGB ?? 0} GB memory and macOS ${pack?.minimumMacOS ?? 15}+ · ${pack?.license ?? ""} license`,
        voices: voiceCatalogue({ [id]: this.voices[id] ?? [] }) };
    });
    return { cacheBytes: await this.cacheInfo(), memoryGB: this.memoryBytes / 1024 ** 3, engines, models, activeEngine: this.activeEngine, prefetchPaused: this.prefetchPaused };
  }
  checkRequirements(id: string, allowLowMemory = false): void {
    const pack = this.models.pack(id);
    if (!this.worker) throw new Error("Voice helper is missing. Use Apple Premium voices or build native/voice-helper.");
    // Tests inject a worker and a synthetic platform, never a downloaded model.
    if (this.platform !== "test" && (this.platform !== "darwin" || process.arch !== "arm64" || Number(release().split(".")[0]) < 24)) {
      throw new Error(`This voice pack requires Apple silicon and macOS ${pack.minimumMacOS}+.`);
    }
    if (allowLowMemory) this.memoryApproved.add(id);
    if (!this.memoryApproved.has(id) && this.memoryBytes < pack.memoryGB * 1024 ** 3) throw new Error(`This voice pack requires ${pack.memoryGB} GB of memory.`);
  }
  private async load(engine: ReadEngine, signal: AbortSignal): Promise<void> {
    if (engine === "system") { this.releaseModel(); return; }
    if (!this.worker) throw new Error("Voice helper is missing. Use Apple Premium voices or build native/voice-helper.");
    if (this.activeEngine === engine && this.activePack === this.packId(engine) && this.worker.isRunning()) return;
    this.beforeLoad?.();
    this.releaseModel();
    const pack = this.models.pack(this.packId(engine));
    this.checkRequirements(pack.id);
    const directory = await this.models.verifiedDirectory(pack.id);
    if ((engine === "qwen" || engine === "qwen-design") && !pack.files.some((file) => file.localPath === "tokenizer.json")) {
      // The runtime may derive this from verified vocab/merges. Rebuild it rather than trusting a stale derived file.
      await rm(join(directory, "tokenizer.json"), { force: true });
    }
    const response = await this.worker.request({ op: "prepare", engine, directory }, signal, 12 * 60_000);
    if (!Array.isArray(response.voices) || response.voices.some((v: unknown) => typeof v !== "string" || (v as string).length > 120)) throw new Error("The engine returned an invalid voice catalogue.");
    this.voices[engine] = engine === "qwen" ? (await this.references.list()).map((r) => ({
      id: r.id, label: r.label, language: "en", tags: r.tags, checksum: referenceChecksum(r)
    })) : response.voices.map((id: string) => {
      const tags = voiceTags(engine, id);
      return { id, label: id.replace(/^(en_)?(us|gb|US|UK)_/, "").replaceAll("_", " "), language: /^(bf|bm)_|(?:gb|UK)_/.test(id) ? "en-GB" : "en-US", ...(tags ? { tags } : {}) };
    });
    this.identities.set(engine, { engineVersion: ENGINE_VERSION, modelChecksum: packChecksum(pack), quantization: pack.quantization, voiceChecksum: "" });
    signal.throwIfAborted();
    this.activeEngine = engine; this.activePack = pack.id; this.ready.add(engine);
  }
  async prepare(engine: unknown, consent: unknown, progress?: (p: InstallProgress) => void, acknowledgedPack?: string, installedOnly = false): Promise<ReaderStatus> {
    if (!isReadEngine(engine) || consent !== true) throw new Error("Confirm the model download before continuing.");
    if (engine === "system") { this.releaseModel(); return this.status(); }
    await this.enqueue(`prepare-${engine}`, async (signal) => {
      await this.refreshCatalogue(await this.models.states());
      const pack = this.models.pack(this.packId(engine));
      if (acknowledgedPack !== undefined && acknowledgedPack !== pack.id) throw new Error("The selected voice pack changed. Review its memory requirements and load it again.");
      this.checkRequirements(pack.id, acknowledgedPack === pack.id);
      try { await this.models.verifiedDirectory(pack.id); }
      catch {
        if (installedOnly) throw new Error("This voice pack is missing or failed verification. Install it again in Local features.");
        await this.models.install(pack.id, true, signal, progress);
      }
      await this.load(engine, signal);
    }); return this.status();
  }
  async designVoice(input: unknown, preview = false): Promise<ReadVoice & { audio?: Uint8Array }> {
    const r = input as { label?: string; description?: string; transcript?: string; provenance?: string; tags?: string[] } | null;
    if (!r || typeof r.label !== "string" || !r.label.trim() || r.label.length > 100 ||
      typeof r.description !== "string" || !r.description.trim() || r.description.length > 1000 ||
      typeof r.transcript !== "string" || !r.transcript.trim() || r.transcript.length > 1000 ||
      typeof r.provenance !== "string" || !r.provenance.trim() || r.provenance.length > 1000 ||
      !Array.isArray(r.tags) || r.tags.length > 20 || r.tags.some((t) => typeof t !== "string" || t.length > 100)) throw new Error("Invalid designed voice request.");
    const request = r as Required<NonNullable<typeof r>>;
    this.pendingDesign = undefined;
    return this.enqueue(`design-${randomUUID()}`, async (signal) => {
      await this.load("qwen-design", signal);
      const result = await this.worker!.request({ op: "design", engine: "qwen-design", text: request.transcript, voice: request.description }, signal, 300_000);
      if (typeof result.audio !== "string" || result.audio.length > 24 * 1024 * 1024) throw new Error("Invalid reference audio.");
      signal.throwIfAborted();
      const audio = Buffer.from(result.audio, "base64");
      if (!validWave(audio)) throw new Error("Invalid reference audio.");
      const metadata = { id: randomUUID(), label: request.label, description: request.description,
        transcript: request.transcript, tags: request.tags, provenance: request.provenance, generatorVersion: ENGINE_VERSION,
        modelChecksum: this.identities.get("qwen-design")!.modelChecksum };
      if (preview) {
        this.pendingDesign = { reference: metadata, audio };
        return { id: metadata.id, label: metadata.label, language: "en", engine: "qwen", audio: new Uint8Array(audio) };
      }
      const reference = await this.references.save(metadata, audio, signal);
      return { id: reference.id, label: reference.label, language: "en", tags: reference.tags, checksum: referenceChecksum(reference), engine: "qwen" };
    });
  }
  async discardDesign(): Promise<void> {
    this.pendingDesign = undefined;
    await this.tail;
    this.savedDesign = undefined;
  }
  async bindDesign(id: unknown): Promise<void> {
    return this.enqueue("bind-design", async (signal) => {
      const saved = this.savedDesign;
      if (!saved || typeof id !== "string" || id !== saved.reference.id) throw new Error("This designed voice is no longer pending.");
      signal.throwIfAborted();
      // Publishing commits the binding. Later cancellation must never remove a voice another window can see.
      await this.references.save(saved.reference, saved.audio);
      this.savedDesign = undefined;
    });
  }
  async keepDesign(id: unknown): Promise<ReadVoice> {
    return this.enqueue("keep-design", async () => {
      const pending = this.pendingDesign;
      if (!pending || typeof id !== "string" || pending.reference.id !== id) throw new Error("Generate another audition before keeping this voice.");
      if (this.savedDesign) throw new Error("Bind or discard the saved voice before keeping another design.");
      this.savedDesign = pending;
      this.pendingDesign = undefined;
      const reference = { ...pending.reference, audioChecksum: createHash("sha256").update(pending.audio).digest("hex") };
      return { id: reference.id, label: reference.label, language: "en", tags: reference.tags, checksum: referenceChecksum(reference), engine: "qwen" };
    });
  }
  synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    if (request.priority === "prefetch" && this.prefetchPaused) return Promise.reject(new Error("Prefetch paused while writing or dictating."));
    return this.enqueue(request.id, async (signal) => {
      if (request.priority === "prefetch" && this.prefetchPaused) throw new Error("Prefetch paused while writing or dictating.");
      if (request.engine === "qwen-design") throw new Error("Design a reference once before playback. Use the Base engine to read lines.");
      if (!this.ready.has(request.engine)) throw new Error("Load the selected voice engine first.");
      if (!this.voices[request.engine]?.some((v) => v.id === request.voice)) throw new Error("That voice is not in this engine's catalogue.");
      if (request.direction?.trim()) throw new Error("This voice engine does not support per-line acting directions.");
      const text = normalizedSpeech(request.text);
      const settings = request.generationSettings;
      if (request.engine === "system" && settings && Object.keys(settings).length) throw new Error("Apple voices do not support these generation settings.");
      if (request.engine === "kokoro" && (settings?.temperature !== undefined || settings?.seed !== undefined) ||
        request.engine !== "kokoro" && settings?.speed !== undefined) throw new Error("Unsupported generation setting for this engine.");
      const reference = request.engine === "qwen" ? await this.references.get(request.voice) : undefined;
      const identity = request.engine === "system" ? {
        engineVersion: `macOS-${release()}-lufs20`, modelChecksum: `system-${release()}`, quantization: "native", voiceChecksum: request.voice
      } : { ...this.identities.get(request.engine)!, voiceChecksum: reference
        ? referenceChecksum(reference.reference) : `${this.identities.get(request.engine)!.modelChecksum}:${request.voice}` };
      await this.directory(); const path = join(this.root, `${audioKey(request, identity)}.wav`);
      const opened = await openForRead(path);
      if (opened) { try { if (opened.info.size <= MAX_AUDIO) { const bytes = await opened.read(); if (validWave(bytes)) { signal.throwIfAborted(); await utimes(path, new Date(), new Date()); return { audio: bytes, cached: true }; } } } finally { await opened.close(); } }
      let bytes: Uint8Array;
      if (request.engine === "system") {
        this.releaseModel();
        const temp = await mkdtemp(join(tmpdir(), "screenplay-voice-")); const file = join(temp, "speech.wav");
        try {
          await this.systemRun(["-v", request.voice, "-o", file, "--file-format=WAVE", "--data-format=LEI16@24000", "-f", "-"], text, signal);
          const output = await openForRead(file);
          if (!output) throw new Error("The system voice produced no audio.");
          try { if (output.info.size > MAX_AUDIO) throw new Error("Generated speech is too large."); bytes = normalizeWave(await output.read()); } finally { await output.close(); }
        } finally { await rm(temp, { recursive: true, force: true }); }
      } else {
        await this.load(request.engine, signal);
        const result = await this.worker!.request({
          op: "synthesize", engine: request.engine, text, voice: request.voice,
          referencePath: reference?.audioPath, referenceText: reference?.reference.transcript, ...settings
        }, signal, 120_000)
          .catch((error) => { this.activeEngine = null; this.worker?.stop(); throw error; });
        if (typeof result.audio !== "string" || result.audio.length > 24 * 1024 * 1024) throw new Error("Invalid generated audio.");
        bytes = new Uint8Array(Buffer.from(result.audio, "base64"));
      }
      signal.throwIfAborted(); if (!validWave(bytes)) throw new Error("The voice engine did not return a valid WAV file.");
      await replaceFile(path, join(this.root, `${randomUUID()}.tmp`), bytes, 0o600); await this.cacheInfo(true);
      return { audio: bytes, cached: false };
    });
  }
}
