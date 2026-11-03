import { dialog } from "electron";
import type { ServiceContext } from "../context.ts";
import { AI_SETTINGS, DEFAULT_OLLAMA_ENDPOINT, sameOllamaModel } from "../../shared/channels/ai.ts";
import { LocalRuntime } from "../models/local-runtime.ts";
import { pickOllamaModel } from "../ai/providers.ts";
import { FORMATTER_MODEL, OllamaModels, type ModelPin, type ModelProgress } from "../models/ollama.ts";
const PINS = "grants.localModelPins.v1";
export function register(ctx: ServiceContext): void {
    const models = new OllamaModels();
    const runtime = new LocalRuntime(ctx.paths.userData);
    const startup = new AbortController();
    const manageRuntime = "grants.startLocalAI";
    if (ctx.settings.get(manageRuntime) === true)
        void runtime.start(startup.signal, () => {}, false).catch(() => {});
    let job: {
        owner: number;
        abort: AbortController;
        done: Promise<unknown>;
    } | null = null;
    let progress: ModelProgress | null = null;
    const pins = (): ModelPin[] => { const raw = ctx.settings.get(PINS); return Array.isArray(raw) ? raw.filter((p: any) => p && typeof p.name === "string" && typeof p.digest === "string") as ModelPin[] : []; };
    const emit = (value: ModelProgress) => { progress = value; ctx.broadcast("models:progress", value); };
    ctx.handle("models:status", async (event, options?: { fromAiSetup?: boolean }) => ({ installed: options?.fromAiSetup === true ? [] : await models.list(), pins: pins(), progress, downloading: !!job, canCancel: job?.owner === event.sender.id, source: FORMATTER_MODEL }));
    ctx.handle("models:pull", async (event, options?: { fromAiSetup?: boolean; setupOnMac?: boolean }) => {
        const window = ctx.windowOf(event.sender);
        if (!window)
            throw new Error("Window closed.");
        if (job)
            throw new Error("A local-model download is already running.");
        if (options?.fromAiSetup !== true) {
            const answer = await dialog.showMessageBox(window, { type: "question", message: "Set up the formatting model on this Mac?", detail: "Cold Open starts Ollama, installing it if needed, then downloads and checks the formatting model. Allow about 4 GB for the download. Your screenplay stays on this Mac. Existing pinned versions stay selected.", buttons: ["Cancel", "Download model"], defaultId: 0, cancelId: 0 });
            if (answer.response !== 1) return null;
        }
        if (job)
            throw new Error("Another window started a download.");
        const abort = new AbortController();
        const stopped = () => abort.abort();
        event.sender.once("destroyed", stopped);
        const target = options?.fromAiSetup === true ? new OllamaModels(fetch, ctx.settings.get<string>(AI_SETTINGS.ollamaEndpoint)?.trim() || DEFAULT_OLLAMA_ENDPOINT) : models;
        const setupOnMac = options?.fromAiSetup === true && options.setupOnMac === true;
        const done = (async () => {
            if (setupOnMac || options?.fromAiSetup !== true) {
                await runtime.start(abort.signal, (status) => emit({ state: "preparing", status }), true);
                abort.signal.throwIfAborted();
                ctx.settings.set(manageRuntime, true);
                if (!setupOnMac) return models.pull(abort.signal, emit);
                const installed = await models.list();
                if (!pickOllamaModel(installed)) installed.push(await models.pull(abort.signal, emit));
                abort.signal.throwIfAborted();
                ctx.settings.set(AI_SETTINGS.ollamaEndpoint, DEFAULT_OLLAMA_ENDPOINT);
                const selected = ctx.settings.get<string>(AI_SETTINGS.model("ollama"));
                if (selected && !installed.some(m => sameOllamaModel(m.name, selected)))
                    ctx.settings.set(AI_SETTINGS.model("ollama"), undefined);
                return;
            }
            return target.pull(abort.signal, emit);
        })();
        const owned = job = { owner: event.sender.id, abort, done };
        try {
            return await done;
        }
        catch (e) {
            emit({ state: abort.signal.aborted ? "paused" : "error", status: abort.signal.aborted ? "Paused. Resume to reuse valid downloaded data." : String(e).slice(0, 400) });
            throw e;
        }
        finally {
            event.sender.removeListener("destroyed", stopped);
            if (job === owned)
                job = null;
        }
    });
    ctx.handle("models:cancel", (event) => { if (job?.owner === event.sender.id)
        job.abort.abort(); });
    ctx.handle("models:use", async (_event, digest: unknown) => {
        if (typeof digest !== "string" || job)
            throw new Error("Finish the download and refresh the model version first.");
        const pin = await models.pin(digest);
        const previous = pins().filter((p) => p.name !== pin.name);
        ctx.settings.set(PINS, [...previous.slice(-19), pin]);
        ctx.settings.set("dictation.provider", "ollama");
        ctx.settings.set("dictation.endpoint", "http://127.0.0.1:11434");
        ctx.settings.set("dictation.localConfirmed", true);
        ctx.settings.set("dictation.model", pin.name);
        return pin;
    });
    ctx.handle("models:select-pin", async (_event, name: unknown) => {
        if (job)
            throw new Error("Finish or pause the download first.");
        const pin = pins().find((p) => p.name === name);
        if (!pin || !(await models.list()).some((m) => m.name === pin.name && m.digest === pin.digest))
            throw new Error("This pinned version is missing or changed. Refresh or repair it before use.");
        ctx.settings.set("dictation.provider", "ollama");
        ctx.settings.set("dictation.endpoint", "http://127.0.0.1:11434");
        ctx.settings.set("dictation.localConfirmed", true);
        ctx.settings.set("dictation.model", pin.name);
        return pin;
    });
    ctx.handle("models:remove", async (event, name: unknown) => {
        if (job)
            throw new Error("Finish or cancel the download first.");
        const pin = pins().find((p) => p.name === name), window = ctx.windowOf(event.sender);
        if (!pin || !window)
            throw new Error("Choose an installed Cold Open version.");
        const answer = await dialog.showMessageBox(window, { type: "warning", message: "Remove this pinned formatter version?", detail: "This removes only Cold Open’s named alias. Shared Ollama source models and files still referenced by other aliases remain. Removing the selected version disables formatting until you select another version.", buttons: ["Keep", "Remove pinned version"], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1)
            return false;
        await models.remove(pin.name, pin.digest);
        ctx.settings.set(PINS, pins().filter((p) => p.name !== pin.name));
        if (ctx.settings.get("dictation.model") === pin.name)
            ctx.settings.set("dictation.model", "");
        return true;
    });
    ctx.onQuit(async () => { startup.abort(); job?.abort.abort(); runtime.stop(); await job?.done.catch(() => { }); });
}
