// File dialogs, reads and writes, and the recent-files list. The renderer converts formats; this only moves bytes.
import { app, clipboard, dialog, shell } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { CHANNELS, type FileFilter, type OpenedFile } from "../../shared/api.ts";
import { saveDialogName } from "../../shared/file-name.ts";
import type { ServiceContext } from "../context.ts";
import { registerRecentFiles } from "../recent-files.ts";
import { fileWriter } from "../file-writer.ts";
import { readChosenFile } from "../safe-fs.ts";

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
    // Only a file name: the page builds it from the script's name, which a co-writing host can set, and a path
    // here would open the dialog in a folder of their choosing. The dialog starts in the last folder used.
    const defaultPath = saveDialogName(options.defaultPath);
    const dialogOptions: Electron.SaveDialogOptions = {
      title: options.title ?? "Save",
      ...(defaultPath ? { defaultPath } : {}),
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

  ctx.handle(CHANNELS.writeFile, fileWriter((path) => ctx.isAllowedPath(path)));

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
