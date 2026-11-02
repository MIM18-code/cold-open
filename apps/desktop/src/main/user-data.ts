// Electron keys the settings folder by the app name, and this app has had three: Screenplay, Inklot, Cold Open.
// A Mac that already has a folder with settings.json keeps using it (settings, recovery copies, history, phone
// inbox), so a rename never leaves a writer's data behind. Moving the folder is not safe: Chromium may already have
// created and opened the new one.
import { join } from "node:path";

/** Folder names the app has used, newest first. The current name's own folder is checked before these. */
export const LEGACY_USER_DATA_NAMES = ["Inklot", "Screenplay"] as const;

/**
 * The older settings folder to keep using, or null to use `current`. `current` wins when it already has settings;
 * otherwise the newest legacy folder that has them.
 */
export function legacyUserDataPath(appData: string, current: string, hasSettings: (folder: string) => boolean): string | null {
  if (hasSettings(current)) return null;
  for (const name of LEGACY_USER_DATA_NAMES) {
    const folder = join(appData, name);
    if (folder !== current && hasSettings(folder)) return folder;
  }
  return null;
}
