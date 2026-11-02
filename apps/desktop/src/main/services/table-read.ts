import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { TABLE_READ, validateSynthesis, isReadEngine } from "../../shared/channels/table-read.ts";
import type { ServiceContext } from "../context.ts";
import { VoiceModelManager } from "../models/voice-manager.ts";
import { VOICE_PACKS } from "../models/voice-manifest.ts";
import { ReferenceBank } from "../tts/reference-bank.ts";
import { ReaderRuntime } from "../tts/runtime.ts";
import { exportRead, type ReadExportRequest } from "../tts/wave-export.ts";

export function register(ctx: ServiceContext): void {
  const models = new VoiceModelManager(join(ctx.paths.userData, "voice-models"), VOICE_PACKS);
  const references = new ReferenceBank(join(ctx.paths.userData, "voice-references"));
  const installs = new Map<number, AbortController>();
  const runtimes = new Map<number, ReaderRuntime>();
  const disposals = new Set<Promise<void>>();
  const dispose = (runtime: ReaderRuntime) => {
    const done = runtime.dispose().catch(() => {});
    disposals.add(done);
    void done.then(() => disposals.delete(done));
  };
  const exports = new Map<number, { abort: AbortController; done: Promise<unknown> }>();
  const destinations = new Set<string>();
  const helper = [join(process.resourcesPath, "voice-helper", "voice-helper"), join(ctx.paths.repoRoot, "native/voice-helper/.build/release/voice-helper")].find(existsSync);
  const get = (sender: Electron.WebContents) => {
    let runtime = runtimes.get(sender.id);
    if (!runtime) {
      runtime = new ReaderRuntime({ root: join(ctx.paths.userData, "table-read-cache"), helper, models, references,
        beforeLoad: () => {
          for (const [id, other] of runtimes) if (id !== sender.id) {
            if (other.isBusy()) throw new Error("Another window is preparing speech. Wait for it to finish.");
            other.releaseModel();
          }
        }
      });
      runtimes.set(sender.id, runtime);
      sender.once("destroyed", () => {
        installs.get(sender.id)?.abort(); installs.delete(sender.id); exports.get(sender.id)?.abort.abort();
        const runtime = runtimes.get(sender.id);
        if (runtime) dispose(runtime);
        runtimes.delete(sender.id);
      });
    }
    return runtime;
  };
  ctx.handle(TABLE_READ.status, (event) => get(event.sender).status());
  ctx.handle(TABLE_READ.catalogue, (event) => get(event.sender).voiceCatalogue());
  ctx.handle(TABLE_READ.models, () => models.states());
  ctx.handle(TABLE_READ.activity, (event, hint: unknown) => get(event.sender).activity(hint));
  ctx.handle(TABLE_READ.design, (event, input: unknown) => {
    const action = (input as { action?: unknown } | null)?.action;
    const runtime = get(event.sender);
    if (action === "keep") return runtime.keepDesign((input as { id?: unknown }).id);
    if (action === "bind") return runtime.bindDesign((input as { id?: unknown }).id);
    if (action === "discard") return runtime.discardDesign();
    if (action !== undefined && action !== "preview") throw new Error("Invalid voice design action.");
    return runtime.designVoice(input, action === "preview");
  });
  ctx.handle(TABLE_READ.install, async (event, id: unknown, consent: unknown, allowLowMemory: unknown = false) => {
    if (typeof id !== "string" || consent !== true) throw new Error("Confirm the voice pack size and requirements first.");
    if (installs.has(event.sender.id)) throw new Error("A voice pack download is already running in this window.");
    if (typeof allowLowMemory !== "boolean") throw new Error("Invalid memory consent.");
    get(event.sender).checkRequirements(id, allowLowMemory);
    const abort = new AbortController(); installs.set(event.sender.id, abort);
    try {
      await models.install(id, true, abort.signal, (progress) => {
        const window = ctx.windowOf(event.sender);
        if (window) ctx.send(window, "table-read:model-progress", progress);
      });
      return models.states();
    } catch (error) {
      // fetch reports Cancel as a bare AbortError; say what happened in the writer's terms.
      if (abort.signal.aborted) throw new Error("Download cancelled.");
      throw error;
    } finally { installs.delete(event.sender.id); ctx.broadcast(TABLE_READ.modelsChanged); }
  });
  ctx.handle(TABLE_READ.remove, async (_event, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid voice pack.");
    models.pack(id);
    if ([...runtimes.values()].some((r) => r.isBusy())) throw new Error("Stop speech jobs before removing a voice pack.");
    for (const runtime of runtimes.values()) runtime.releaseModel();
    try { await models.remove(id); }
    finally {
      for (const runtime of runtimes.values()) runtime.invalidatePack(id);
      ctx.broadcast(TABLE_READ.modelsChanged);
    }
    return models.states();
  });
  ctx.handle(TABLE_READ.prepare, (event, engine: unknown, consent: unknown, acknowledgedPack: unknown = undefined, installedOnly: unknown = false) => {
    if (acknowledgedPack !== undefined && typeof acknowledgedPack !== "string" || typeof installedOnly !== "boolean") throw new Error("Invalid voice loading options.");
    return get(event.sender).prepare(engine, consent, (progress) => {
      const window = ctx.windowOf(event.sender);
      if (window) ctx.send(window, "table-read:model-progress", progress);
    }, acknowledgedPack, installedOnly);
  });
  ctx.handle(TABLE_READ.synthesize, (event, request: unknown) => {
    if (exports.has(event.sender.id)) throw new Error("An audio export is using this window's voice engine. Finish or cancel it before playback.");
    return get(event.sender).synthesize(validateSynthesis(request));
  });
  ctx.handle(TABLE_READ.cancel, (event) => { installs.get(event.sender.id)?.abort(); exports.get(event.sender.id)?.abort.abort(); runtimes.get(event.sender.id)?.cancel(); });
  ctx.handle(TABLE_READ.clearCache, (event) => {
    if (exports.has(event.sender.id)) throw new Error("Cancel the export before clearing the cache.");
    return get(event.sender).clearCache();
  });
  ctx.handle("table-read:export", async (event, input: unknown) => {
    const request = input as ReadExportRequest | null;
    if (!request || typeof request.id !== "string" || !/^[\w-]{1,70}$/.test(request.id) || !isReadEngine(request.engine) ||
      typeof request.path !== "string" || !request.path.toLowerCase().endsWith(".wav") || !ctx.isAllowedPath(request.path) ||
      typeof request.title !== "string" || request.title.length > 300 || !Array.isArray(request.cues) || !request.cues.length || request.cues.length > 5000 ||
      !Number.isFinite(request.gapMs) || request.gapMs < 0 || request.gapMs > 2000) throw new Error("Invalid audio export. Choose a WAV destination with the Save dialog.");
    for (const cue of request.cues) {
      if (!cue || typeof cue.scene !== "string" || cue.scene.length > 500 || typeof cue.speaker !== "string" || cue.speaker.length > 120 || typeof cue.id !== "string" || cue.id.length > 200) throw new Error("Invalid read-plan passage.");
      validateSynthesis({ id: request.id, engine: request.engine, voice: cue.voice, text: cue.text });
    }
    const destination = resolve(request.path);
    if (exports.has(event.sender.id) || destinations.has(destination)) throw new Error("That window or destination is already exporting audio.");
    const abort = new AbortController(), runtime = get(event.sender);
    runtime.cancel(); destinations.add(destination);
    const done = exportRead({ ...request, path: destination }, abort.signal, (speech) => runtime.synthesize(speech), (completed, total) => {
      const window = ctx.windowOf(event.sender);
      if (window) ctx.send(window, "table-read:export-progress", { id: request.id, completed, total });
    });
    exports.set(event.sender.id, { abort, done });
    try { return await done; }
    finally { if (exports.get(event.sender.id)?.abort === abort) exports.delete(event.sender.id); destinations.delete(destination); }
  });
  ctx.onQuit(async () => {
    for (const abort of installs.values()) abort.abort();
    for (const job of exports.values()) job.abort.abort();
    for (const r of runtimes.values()) dispose(r);
    runtimes.clear();
    await Promise.allSettled([...exports.values()].map((job) => job.done));
    await Promise.allSettled([...disposals]);
    exports.clear();
  });
}
