// The recent-files list. It is also an access list: a recent file can be opened again without a dialog, after a
// restart too, so only files the writer already reached (a dialog, Finder, the Dock) may join it, and at launch
// only entries that are still screenplay files, and not links, are allowed again: a link could have been put in a
// script's place (in a folder a co-writer shares) while the app was closed. Kept apart from files.ts so it can be
// tested without Electron.
import { statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";

import { CHANNELS } from "../shared/api.ts";
import type { ServiceContext } from "./context.ts";
import { isLink } from "./safe-fs.ts";

export const RECENT_KEY = "files.recent";
const RECENT_LIMIT = 15;
/** File types the app opens as screenplays. */
export const SCREENPLAY_EXTENSIONS: readonly string[] = ["screenplay", "fdx", "fountain", "spmd", "txt"];

/** A path that may be reopened from the recent list: an existing regular file of a type the app opens. */
export function isScreenplayFile(path: unknown): path is string {
  if (typeof path !== "string" || !isAbsolute(path) || !SCREENPLAY_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function registerRecentFiles(ctx: ServiceContext, addRecentDocument: (path: string) => void): void {
  const stored = (): string[] => {
    const value = ctx.settings.get<unknown>(RECENT_KEY);
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : [];
  };
  for (const path of stored()) if (isScreenplayFile(path) && !isLink(path)) ctx.allowPath(path);

  // Only entries this run may open: a moved or deleted file, or one that was never a screenplay, is not offered.
  ctx.handle(CHANNELS.recentFiles, () => stored().filter((path) => ctx.isAllowedPath(path)));
  ctx.handle(CHANNELS.addRecent, (_event, path: unknown) => {
    if (typeof path !== "string" || !ctx.isAllowedPath(path)) throw new Error("That file was not opened through the app.");
    if (!isScreenplayFile(path)) return;
    ctx.settings.set(RECENT_KEY, [path, ...stored().filter((p) => p !== path)].slice(0, RECENT_LIMIT));
    addRecentDocument(path);
  });
}
