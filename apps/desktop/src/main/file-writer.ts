// The handler behind "write this file". It has no Electron in it, so it can be tested on its own.
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { randomSuffix, readChosenFile, replaceFile } from "./safe-fs.ts";

const digest = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/**
 * Write to a unique temporary file and rename, so a crash mid-write never leaves half a script. Writes to the same
 * destination run one after another, so overlapping saves land in the order they were asked for. The script may sit
 * in a folder a co-writer shares, so the temporary name is random and created only if nothing is there: a link
 * planted at a guessable name would otherwise carry the script into whatever file it points at.
 */
export function fileWriter(isAllowedPath: (path: string) => boolean) {
  const queues = new Map<string, Promise<unknown>>();
  return (_event: unknown, path: string, data: Uint8Array | string, expectedHash?: string): Promise<string> => {
    if (!isAllowedPath(path)) throw new Error("Choose where to save with the Save dialog first.");
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
      // This write may have waited behind another, and has just read the file. The folder is checked again as it is
      // now, as late as it can be: one swapped for a link meanwhile would otherwise take the script somewhere the
      // writer never chose.
      if (!isAllowedPath(path)) throw new Error("Choose where to save with the Save dialog first.");
      await replaceFile(destination, `${destination}.saving-${process.pid}-${randomSuffix()}`, data);
      return digest(data);
    };
    const next = (queues.get(destination) ?? Promise.resolve()).catch(() => undefined).then(write);
    queues.set(destination, next);
    void next.finally(() => queues.get(destination) === next && queues.delete(destination)).catch(() => undefined);
    return next;
  };
}
