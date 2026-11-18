// The recent-files list. It is also an access list: a recent file can be opened again without a dialog, after a
// restart too, so only files the writer already reached (a dialog, Finder, the Dock) may join it, and at launch
// only entries that are still screenplay files, and not links, are allowed again: a link could have been put in a
// script's place (in a folder a co-writer shares) while the app was closed. A folder above the script could have
// been swapped for a link too, which the path alone does not show, so each entry is stored with where it really
// sat (its folder's real path plus its name) and is allowed again only while it still sits there. Kept apart from
// files.ts so it can be tested without Electron.
import { statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";

import { CHANNELS } from "../shared/api.ts";
import type { ServiceContext } from "./context.ts";
import { isLink, realLocation } from "./safe-fs.ts";

export const RECENT_KEY = "files.recent";
/** Path → where it really sat when it joined the recent list. Main-owned like every files.* setting. */
export const RECENT_LOCATIONS_KEY = "files.recentLocations";
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

/**
 * Whether a path remembered from an earlier run may be opened again without a dialog: still a screenplay file, not
 * a link, and still at the real location stored with it. A path remembered before locations were stored has none
 * and is taken as it is, once; the caller stores its location from then on.
 */
export function reopenable(path: unknown, location: unknown): path is string {
  return isScreenplayFile(path) && !isLink(path) && (typeof location !== "string" || realLocation(path) === location);
}

export function registerRecentFiles(ctx: ServiceContext, addRecentDocument: (path: string) => void): void {
  const stored = (): string[] => {
    const value = ctx.settings.get<unknown>(RECENT_KEY);
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : [];
  };
  const locations = (): Map<string, string> => {
    const value = ctx.settings.get<unknown>(RECENT_LOCATIONS_KEY);
    const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
    return new Map(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  };
  /** Keep locations for the listed paths only, so the map never outgrows the list. */
  const storeLocations = (paths: string[], known: Map<string, string>) => {
    const next = Object.fromEntries(paths.flatMap((path) => known.has(path) ? [[path, known.get(path)!]] : []));
    if (JSON.stringify(next) !== JSON.stringify(Object.fromEntries(locations()))) ctx.settings.set(RECENT_LOCATIONS_KEY, next);
  };

  const known = locations();
  for (const path of stored()) {
    if (!reopenable(path, known.get(path))) continue;
    ctx.allowPath(path);
    const location = realLocation(path);
    if (!known.has(path) && location) known.set(path, location);
  }
  storeLocations(stored(), known);

  // Only entries this run may open: a moved or deleted file, or one that was never a screenplay, is not offered.
  ctx.handle(CHANNELS.recentFiles, () => stored().filter((path) => ctx.isAllowedPath(path)));
  ctx.handle(CHANNELS.addRecent, (_event, path: unknown) => {
    if (typeof path !== "string" || !ctx.isAllowedPath(path)) throw new Error("That file was not opened through the app.");
    if (!isScreenplayFile(path)) return;
    const paths = [path, ...stored().filter((p) => p !== path)].slice(0, RECENT_LIMIT);
    ctx.settings.set(RECENT_KEY, paths);
    // The grant was just checked, so this is the location the writer chose the file at.
    const location = realLocation(path);
    const all = locations();
    if (location) all.set(path, location);
    else all.delete(path);
    storeLocations(paths, all);
    addRecentDocument(path);
  });
}
