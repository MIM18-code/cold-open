// Folder sync between windows and disk. Each synced document has one FolderSync, shared by every window that has
// it open. Local changes from a window are batched for a moment and appended to this device's log, and passed
// straight to the document's other windows (the watcher only reads other devices' logs). A window can hold more than
// one subscription to a document for a moment (Revert while sync starts), so each start gets its own ID and only
// that ID can append or stop.
import { randomId } from "@screenplay/relay/protocol";
import type { WebContents } from "electron";
import * as Y from "yjs";

import { DEVICE_ID_SETTING, FOLDER_SYNC_SETTING, SYNC, type FolderStartResult } from "../../shared/channels/sync.ts";
import type { ServiceContext } from "../context.ts";
import { UnsafeFileError } from "../safe-fs.ts";
import { FolderSync, hasSyncFolder, isUpdate, syncFolderFor } from "./folder-sync.ts";

const FLUSH_DELAY = 250;
const RETRY_DELAY = 5000;
const FINAL_ATTEMPTS = 3;
const FINAL_RETRY_DELAY = 200;

interface Entry {
  path: string;
  sync: FolderSync;
  started: Promise<Uint8Array[]>;
  /** Subscription ID → the window that holds it. */
  subscribers: Map<string, WebContents>;
  pending: Uint8Array[];
  /**
   * The records of an append that failed, kept as they were so the retry sends the same ones: FolderSync skips any
   * that reached the log before the failure, and on a full disk the retry then needs room only for the rest.
   */
  retry: Uint8Array[];
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The last flush, which the next one waits for. */
  flushing: Promise<void>;
}

export function registerFolderSync(ctx: ServiceContext): void {
  const entries = new Map<string, Entry>();
  const watched = new WeakSet<WebContents>();
  // Documents whose last subscriber left and whose sync is still writing its final changes, by path. Quitting waits
  // for them, and so does starting the same document again (two writers must never share one log file).
  const stopping = new Map<string, Promise<void>>();

  const deviceId = (): string => {
    let id = ctx.settings.get<string>(DEVICE_ID_SETTING);
    if (!id) ctx.settings.set(DEVICE_ID_SETTING, (id = randomId()));
    return id;
  };
  const choices = (): Record<string, boolean> => ctx.settings.get<Record<string, boolean>>(FOLDER_SYNC_SETTING) ?? {};
  const checkPath = (path: unknown): string => {
    if (typeof path !== "string" || !ctx.isAllowedPath(path)) throw new Error("That document was not opened through the app.");
    return path;
  };
  const windowsOf = (entry: Entry) => new Set([...entry.subscribers.values()].filter((contents) => !contents.isDestroyed()));
  const sendAll = (entry: Entry, channel: string, ...args: unknown[]) => {
    for (const contents of windowsOf(entry)) contents.send(channel, entry.path, ...args);
  };

  /** Write the batched changes, and wait for writes already queued (a timer's flush still under way). */
  const flush = (entry: Entry): Promise<void> => {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    // One flush at a time, so changes kept from a failed append go out ahead of later ones.
    const run = entry.flushing.catch(() => undefined).then(async () => {
      const kept = entry.retry.splice(0);
      const updates = entry.pending.splice(0);
      if (!kept.length && !updates.length) return entry.sync.append([]);
      let records = updates;
      if (updates.length > 1) {
        try {
          records = [Y.mergeUpdates(updates)];
        } catch {
          // Written apart, below.
        }
      }
      if (records === updates) {
        // One update on its own, or a batch that will not merge. One bad update (only a compromised page sends one)
        // must not reach the log, where every other Mac would warn about it, or cost the good ones beside it. Drop
        // what is not an update and write the rest as records of their own: readers apply records one at a time, so
        // one that decodes but still will not merge costs only itself. Nothing is kept to retry, so this never repeats.
        records = updates.filter(isUpdate);
        const dropped = updates.length - records.length;
        if (dropped) {
          sendAll(entry, SYNC.folderError, `Folder sync skipped ${dropped === 1 ? "a change from this window that is not a script change" : `${dropped} changes from this window that are not script changes`}. `
            + "The other changes still sync.");
        }
      }
      records = [...kept, ...records];
      try {
        await entry.sync.append(records);
      } catch (error) {
        // A broken sync folder (replaced by a link or non-directory) never recovers until sync restarts.
        if (error instanceof UnsafeFileError) throw error;
        // Keep the records for the next flush, and try again. FolderSync repairs the log first if the failed append
        // left part of a record behind, so the retry is readable.
        entry.retry = records;
        if (entries.get(entry.path) === entry) entry.timer ??= setTimeout(() => void flush(entry).catch(() => undefined), RETRY_DELAY);
        throw error;
      }
    });
    entry.flushing = run;
    return run;
  };

  /**
   * A flush that nothing will retry later (the last window closed, or the app is quitting): try a few times, briefly,
   * so closing and quitting never hang on a disk that stays full. If every try fails the batch is not in the folder
   * log; the document still has it, and the next start writes what the log lacks.
   */
  const finalFlush = async (entry: Entry): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await flush(entry);
      } catch (error) {
        if (error instanceof UnsafeFileError || attempt >= FINAL_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, FINAL_RETRY_DELAY));
      }
    }
  };

  const finish = (entry: Entry): Promise<void> => {
    entries.delete(entry.path);
    const done = (async () => {
      await finalFlush(entry).catch(() => undefined);
      await entry.sync.stop();
    })();
    stopping.set(entry.path, done);
    void done.finally(() => stopping.get(entry.path) === done && stopping.delete(entry.path));
    return done;
  };

  const unsubscribe = (path: string, matches: (id: string, contents: WebContents) => boolean): Promise<void> => {
    const entry = entries.get(path);
    if (!entry) return Promise.resolve();
    for (const [id, contents] of [...entry.subscribers]) if (matches(id, contents)) entry.subscribers.delete(id);
    return entry.subscribers.size ? Promise.resolve() : finish(entry);
  };

  ctx.handle(SYNC.folderEnabled, (_event, path: string) => {
    if (typeof path !== "string" || !ctx.isAllowedPath(path)) return false;
    const choice = choices()[path];
    // Only a real folder turns sync on by itself: a link in its place (put there through a shared folder) does not.
    return choice ?? hasSyncFolder(path);
  });

  ctx.handle(SYNC.folderSet, (_event, path: string, on: boolean) => {
    checkPath(path);
    ctx.settings.set(FOLDER_SYNC_SETTING, { ...choices(), [path]: !!on });
  });

  ctx.handle(SYNC.folderStart, async (event, path: string, state: Uint8Array): Promise<FolderStartResult> => {
    checkPath(path);
    if (!(state instanceof Uint8Array)) throw new Error("Folder sync needs the document's state.");
    const contents = event.sender;
    if (!watched.has(contents)) {
      watched.add(contents);
      contents.once("destroyed", () => {
        for (const entry of [...entries.values()]) void unsubscribe(entry.path, (_id, holder) => holder === contents);
      });
    }
    const subscription = randomId();
    await stopping.get(path);
    if (contents.isDestroyed()) throw new Error("The window closed.");
    let entry = entries.get(path);
    if (entry) {
      entry.subscribers.set(subscription, contents);
      await entry.started;
      return { folder: entry.sync.folder, deviceId: entry.sync.deviceId, subscription, updates: await entry.sync.snapshot() };
    }
    const sync: FolderSync = new FolderSync({
      folder: syncFolderFor(path),
      deviceId: deviceId(),
      onUpdates: (updates) => created && sendAll(created, SYNC.folderUpdates, updates),
      onError: (error) => created && sendAll(created, SYNC.folderError, error instanceof Error ? error.message : String(error)),
    });
    const created: Entry = { path, sync, started: sync.start(state), subscribers: new Map([[subscription, contents]]), pending: [], retry: [], timer: undefined, flushing: Promise.resolve() };
    entries.set(path, created);
    try {
      return { folder: sync.folder, deviceId: sync.deviceId, subscription, updates: await created.started };
    } catch (error) {
      if (entries.get(path) === created) entries.delete(path);
      await sync.stop();
      throw error;
    }
  });

  ctx.handle(SYNC.folderAppend, (event, path: string, subscription: string, update: Uint8Array) => {
    const entry = entries.get(path);
    if (!entry || entry.subscribers.get(subscription) !== event.sender || !(update instanceof Uint8Array)) return;
    entry.pending.push(update);
    // FolderSync reports append failures through onError; flush reports skipped changes directly.
    entry.timer ??= setTimeout(() => void flush(entry).catch(() => undefined), FLUSH_DELAY);
    for (const contents of windowsOf(entry)) if (contents !== event.sender) contents.send(SYNC.folderUpdates, path, [update]);
  });

  ctx.handle(SYNC.folderStop, (event, path: string, subscription: string) =>
    unsubscribe(path, (id, contents) => id === subscription && contents === event.sender));

  // Only flush: the writer may still cancel the quit at a "Save changes?" prompt, and sync must keep working then.
  // Closing windows stops each document's sync as usual; quitting waits for those still writing their last changes.
  ctx.onQuit(async () => {
    await Promise.all([...[...entries.values()].map((entry) => finalFlush(entry).catch(() => undefined)), ...stopping.values()]);
  });
}
