// The files a page may read and write: those the writer picked in a dialog or opened from Finder, the Dock or the
// recent list. A grant is for the file the path named when it was given. A script can sit in a folder someone else
// changes (Dropbox shared with a co-writer), and they could later replace it with a link to another file on this
// Mac, or replace a folder above it with a link; the grant never follows such a swap. A link the writer already had
// when they opened the file keeps working. Kept apart from context.ts, which needs Electron, so tests can load it.
import { resolve } from "node:path";

import { realLocation, realOrNull } from "./safe-fs.ts";

interface Pin {
  /** Where the path itself sat (its folder's real path plus its name), or null if that folder was missing. */
  location: string | null;
  /** The file it led to, or null if there was none yet (a Save As target). */
  target: string | null;
}

const pinOf = (full: string): Pin => ({ location: realLocation(full), target: realOrNull(full) });

export class PathGrants {
  private readonly granted = new Map<string, { pin: Pin; writable: boolean }>();

  allow(path: string, access: "read" | "write" = "write"): void {
    const full = resolve(path);
    const writable = access === "write" || this.allows(full);
    this.granted.set(full, { pin: pinOf(full), writable });
  }

  /** Whether `path` was granted and still leads where it did then, or to a regular file of its own at the same place. */
  allows(path: string, access: "read" | "write" = "write"): boolean {
    const full = resolve(path);
    const grant = this.granted.get(full);
    if (!grant || access === "write" && !grant.writable) return false;
    const { pin } = grant;
    const now = pinOf(full);
    if (pin.location === null) {
      // Granted before its folder existed: the first time the folder is there pins it.
      if (now.location !== null) this.granted.set(full, { ...grant, pin: now });
      return true;
    }
    // A missing folder fails the read or write by itself.
    if (now.location === null) return true;
    if (now.location !== pin.location) return false;
    // Nothing there yet, the same file as before, or a file at the path itself (a save replaced a link the writer had).
    return now.target === null || now.target === pin.target || now.target === now.location;
  }
}
