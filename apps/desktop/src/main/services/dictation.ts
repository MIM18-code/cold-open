// Dictation: turns a recorded take or a pasted transcript into proposed screenplay elements. The work is in
// src/main/dictation; this file owns the IPC channels, progress events and the microphone permission.
import { app, dialog, session, systemPreferences } from "electron";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DICTATION, SETTING_KEYS, type FormatTextRequest, type MicStatus, type ProcessAudioRequest, type ProgressStage, type TakeProgress,
} from "../../shared/channels/dictation.ts";
import type { ServiceContext } from "../context.ts";
import type { DictationRuntime } from "../dictation/runtime.ts";

/**
 * Permissions other features use from the app's own page: copying an invite or a report goes through the async
 * clipboard, and the window may go full screen. The handlers below are the whole app's (they replace Electron's
 * allow-everything default), so they must grant these; anything not listed is denied.
 */
const OWN_PAGE_PERMISSIONS: ReadonlySet<string> = new Set(["clipboard-sanitized-write", "clipboard-read", "fullscreen"]);

/** The microphone is for the app's own page and nothing else: not another site, not a subframe, not the camera. */
function allowOwnMicrophone(): void {
  // Services register while the app is still starting; the session exists once it is ready.
  void app.whenReady().then(applyMicrophonePolicy);
}

function applyMicrophonePolicy(): void {
  const devUrl = process.env.SCREENPLAY_DEV_URL;
  const ownPage = join(import.meta.dirname, "../renderer/index.html");
  const isOwn = (url: string) => (devUrl ? url.startsWith(devUrl) : url.startsWith(pathToFileURL(ownPage).href));
  const audioOnly = (types?: readonly string[]) => !types || types.every((type) => type === "audio");
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission === "media") return callback(isOwn(details.requestingUrl) && audioOnly((details as { mediaTypes?: string[] }).mediaTypes));
    callback(OWN_PAGE_PERMISSIONS.has(permission) && isOwn(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const url = (details as { requestingUrl?: string }).requestingUrl ?? requestingOrigin;
    return (permission === "media" || OWN_PAGE_PERMISSIONS.has(permission)) && isOwn(url);
  });
}

/** The renderer sends bytes; anything else is refused before it is copied into a buffer of that size. */
function audioBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("The recording is not audio data.");
}

async function micStatus(): Promise<MicStatus> {
  if (process.platform !== "darwin") return "granted";
  const status = systemPreferences.getMediaAccessStatus("microphone");
  // Tests use a fake microphone and must never raise the system prompt.
  if (status === "not-determined" && !process.env.SCREENPLAY_E2E) {
    return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
  }
  return process.env.SCREENPLAY_E2E ? "granted" : status;
}

export function register(ctx: ServiceContext): void {
  allowOwnMicrophone();

  let runtime: Promise<DictationRuntime> | undefined;
  const load = () => (runtime ??= import("../dictation/runtime.ts").then(({ DictationRuntime }) => new DictationRuntime({
    settings: () => ctx.settings.all(),
    lookup: { repoRoot: ctx.paths.repoRoot, env: process.env, resourcesPath: process.resourcesPath },
  })));
  ctx.onQuit(async () => (await runtime)?.close());

  const progressTo = (sender: Electron.WebContents, takeId: number) => (stage: ProgressStage) => {
    const window = ctx.windowOf(sender);
    if (window) ctx.send(window, DICTATION.progress, { takeId, stage } satisfies TakeProgress);
  };

  ctx.handle(DICTATION.process, async (event, request: ProcessAudioRequest) => {
    const audio = audioBytes(request?.audio);
    return (await load()).processAudio({ ...request, audio }, progressTo(event.sender, request.takeId));
  });
  // Jobs belong to a webContents, not to a document name or globally shared take ID.
  const formatting = new Map<number, Map<number, AbortController>>();
  ctx.onQuit(() => {
    for (const jobs of formatting.values()) for (const job of jobs.values()) job.abort();
    formatting.clear();
  });
  ctx.handle(DICTATION.format, async (event, request: FormatTextRequest) => {
    if (typeof request?.text !== "string") throw new Error("There is no text to format.");
    if (!Number.isSafeInteger(request.takeId) || request.takeId < 0) throw new Error("Invalid formatting request ID.");
    const owner = event.sender.id;
    let jobs = formatting.get(owner);
    if (!jobs) {
      jobs = new Map();
      formatting.set(owner, jobs);
      event.sender.once("destroyed", () => {
        for (const job of formatting.get(owner)?.values() ?? []) job.abort();
        formatting.delete(owner);
      });
    }
    if (jobs.has(request.takeId)) throw new Error("That formatting request is already running.");
    if (jobs.size >= 2) throw new Error("Finish or cancel the current formatting request first.");
    const controller = new AbortController();
    jobs.set(request.takeId, controller);
    try {
      return await (await load()).processText(request, progressTo(event.sender, request.takeId), controller.signal);
    } finally {
      jobs.delete(request.takeId);
    }
  });
  ctx.handle(DICTATION.cancelFormat, (event, takeId: number) => {
    if (Number.isSafeInteger(takeId)) formatting.get(event.sender.id)?.get(takeId)?.abort();
  });
  ctx.handle(DICTATION.prepare, async () => (await load()).prepare());
  ctx.handle(DICTATION.check, async () => (await load()).check());
  ctx.handle(DICTATION.status, async () => (await load()).status());
  ctx.handle(DICTATION.micAccess, () => micStatus());
  // The main process runs the helper, so only the writer's pick in this native dialog chooses it. The choice is kept
  // in a grants.* setting, which pages cannot set.
  ctx.handle(DICTATION.chooseHelper, async (event) => {
    const window = ctx.windowOf(event.sender);
    const options: Electron.OpenDialogOptions = { title: "Choose the speech helper", properties: ["openFile"], buttonLabel: "Choose" };
    const result = window && window.isVisible() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    try {
      const real = realpathSync(path);
      if (!statSync(real).isFile()) throw new Error("not a file");
      accessSync(real, constants.X_OK);
    } catch {
      throw new Error(`${path} is not a program the app can run.`);
    }
    ctx.settings.set(SETTING_KEYS.helperPath, path);
    return path;
  });
  ctx.handle(DICTATION.clearHelper, () => ctx.settings.set(SETTING_KEYS.helperPath, undefined));
}
