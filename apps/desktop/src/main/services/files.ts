// File dialogs, reads and writes, and the recent-files list. The renderer converts formats; this only moves bytes.
import { app, clipboard, dialog, shell } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { CHANNELS, type FileFilter, type OpenedFile } from "../../shared/api.ts";
import type { ServiceContext } from "../context.ts";
import { registerRecentFiles } from "../recent-files.ts";
import { randomSuffix, readChosenFile, replaceFile } from "../safe-fs.ts";

const digest = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
export function register(ctx: ServiceContext): void {
  ctx.handle("clipboard:read-text", async () => { const text = await clipboard.readText(); if (text.length > 500_000) throw new Error("Paste up to 500,000 characters at a time."); return text; });
  registerRecentFiles(ctx, (path) => app.addRecentDocument(path));

  ctx.handle(CHANNELS.openDialog, async (event, options: { title?: string; filters?: FileFilter[]; multiple?: boolean } = {}) => {
    const window = ctx.windowOf(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: options.title ?? "Open",
      properties: options.multiple ? ["openFile", "multiSelections"] : ["openFile"],
      ...(options.filters ? { filters: options.filters } : {}),
    };
    const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled) return [];
    const files: OpenedFile[] = [];
    for (const path of result.filePaths) {
      ctx.allowPath(path);
      const data = await readChosenFile(path);
      files.push({ path, name: basename(path), data, fileHash: digest(data) });
    }
    return files;
  });

  ctx.handle(CHANNELS.saveDialog, async (event, options: { title?: string; defaultPath?: string; filters?: FileFilter[] } = {}) => {
    const window = ctx.windowOf(event.sender);
    const dialogOptions: Electron.SaveDialogOptions = {
      title: options.title ?? "Save",
      ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
      ...(options.filters ? { filters: options.filters } : {}),
    };
    const result = window ? await dialog.showSaveDialog(window, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return null;
    ctx.allowPath(result.filePath);
    return result.filePath;
  });

  ctx.handle(CHANNELS.readFile, async (_event, path: string): Promise<OpenedFile> => {
    if (!ctx.isAllowedPath(path)) throw new Error("That file was not opened through the app, or it was replaced by a link since. Open it again with File > Open.");
    const data = await readChosenFile(path);
    return { path, name: basename(path), data, fileHash: digest(data) };
  });

  // Write to a unique temporary file and rename, so a crash mid-write never leaves half a script. Writes to the
  // same destination run one after another, so overlapping saves land in the order they were asked for. The script
  // may sit in a folder a co-writer shares, so the temporary name is random and created only if nothing is there:
  // a link planted at a guessable name would otherwise carry the script into whatever file it points at.
  const queues = new Map<string, Promise<unknown>>();
  ctx.handle(CHANNELS.writeFile, (_event, path: string, data: Uint8Array | string, expectedHash?: string) => {
    if (!ctx.isAllowedPath(path)) throw new Error("Choose where to save with the Save dialog first.");
    if (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Invalid saved-file fingerprint.");
    const destination = resolve(path);
    // Check the last-opened version immediately before atomic replacement in this destination's serialized queue.
    // Without an expected hash (Save As, export, recovery), the explicit destination selection authorizes writing.
    const write = async () => {
      if (expectedHash) {
        let current: Uint8Array;
        try { current = await readChosenFile(destination); }
        catch { throw new Error("FILE_CHANGED: The original file was removed or replaced outside this app."); }
        if (digest(current) !== expectedHash) throw new Error("FILE_CHANGED: Another app or window changed this file since you opened it.");
      }
      await replaceFile(destination, `${destination}.saving-${process.pid}-${randomSuffix()}`, data);
      return digest(data);
    };
    const next = (queues.get(destination) ?? Promise.resolve()).catch(() => undefined).then(write);
    queues.set(destination, next);
    void next.finally(() => queues.get(destination) === next && queues.delete(destination)).catch(() => undefined);
    return next;
  });

  // Crash-recovery copies. Backups found at launch belong to a previous run, so only the first request sees them.
  const autosaveDir = join(ctx.paths.userData, "autosave");
  let offeredRecovery = false;
  ctx.handle("files:autosave-dir", async () => {
    await mkdir(autosaveDir, { recursive: true });
    return autosaveDir;
  });
  ctx.handle("files:list-autosaves", async () => {
    if (offeredRecovery) return [];
    offeredRecovery = true;
    try {
      return (await readdir(autosaveDir)).filter((name) => name.endsWith(".screenplay")).map((name) => join(autosaveDir, name));
    } catch {
      return [];
    }
  });
  ctx.handle("files:remove-autosave", async (_event, path: string) => {
    if (typeof path === "string" && dirname(resolve(path)) === autosaveDir) await rm(resolve(path), { force: true });
  });

  ctx.handle(CHANNELS.revealInFinder, (_event, path: string) => {
    if (ctx.isAllowedPath(path)) shell.showItemInFolder(path);
  });
}
