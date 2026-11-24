// Folder sync for one document: a sidecar folder next to the file ("Draft.screenplay-sync/") holding one update log
// per device. This device appends its changes to its own log; the other devices' logs are watched (fs.watch, plus a
// periodic rescan because cloud folders deliver changes late and fs.watch misses some) and their new records are
// handed to onUpdates. No Electron here, so tests drive it directly.
//
// The folder is shared: anyone who can write it (a co-writer on a shared Dropbox folder) can put links and special
// files in it. Folder sync never follows a link. The folder itself must be a real directory, not a link, and must
// stay at the real path it had at start; each log is opened with O_NOFOLLOW and used only if it is a regular file
// (safe-fs.ts); new files are created with O_EXCL under random names. A log that fails these checks is skipped and
// reported once; a folder that fails them stops sync with an error. This Mac's text stays in the document either way.
//
// The same people can write anything into a log. A checksum only shows that a record arrived whole, so each record
// is also decoded as a Yjs update before it is passed on, and one that is not an update is skipped and reported.
// Each log is read on its own: a log that is too large, or that cannot be read, is skipped and reported while the
// others are still delivered.
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import * as Y from "yjs";

import { UnsafeFileError, appendRegular, isRealDirectory, openForRead, randomSuffix, truncateRegular, writeNewFile } from "../safe-fs.ts";
import { LOG_EXTENSION, MAX_LOG_BYTES, encodeHeader, encodeRecords, generationOf, parseLog } from "./folder-log.ts";

export function syncFolderFor(docPath: string): string {
  return join(dirname(docPath), `${basename(docPath, extname(docPath))}.screenplay-sync`);
}

/** Whether the document has a sync folder: a real directory next to it. A link in its place does not count. */
export function hasSyncFolder(docPath: string): boolean {
  return isRealDirectory(syncFolderFor(docPath));
}

export interface FolderSyncOptions {
  folder: string;
  deviceId: string;
  /** New records from other devices' logs. */
  onUpdates(updates: Uint8Array[]): void;
  onError?(error: unknown): void;
  /** How often to rescan the folder regardless of fs.watch, in milliseconds. */
  rescanMs?: number;
  /** Rewrite this device's log as one record once it grows past this many bytes. */
  compactBytes?: number;
  /** Use fs.watch as well as the rescan (tests turn it off to simulate slow delivery). */
  watch?: boolean;
  /** Skip a log larger than this many bytes instead of reading it. */
  maxLogBytes?: number;
}

interface ReaderState {
  generation: string | null;
  end: number;
  size: number;
  mtimeMs: number;
}

const isUnsafe = (error: unknown): error is UnsafeFileError => error instanceof UnsafeFileError;

export class FolderSync {
  readonly folder: string;
  readonly deviceId: string;
  readonly ownLog: string;
  private readonly options: FolderSyncOptions;
  private readonly readers = new Map<string, ReaderState>();
  /** Writes to our own log run one at a time, in order. */
  private queue: Promise<void> = Promise.resolve();
  private ownBytes = 0;
  /**
   * The records our log holds, as this device wrote them. If the log is lost (deleted, or replaced by a link) the
   * new one starts with all of them, so a device that had not read the old log yet still gets every change.
   */
  private ownRecords: Uint8Array[] = [];
  /** Size of our log right after the last rewrite; compaction waits until the log has grown well past it. */
  private compactedBytes = 0;
  /** An append failed partway, so our log may end in a torn record that would hide anything appended after it. */
  private tornTail = false;
  /** The generation of the log this device last wrote or read as its own. A copy from before a rewrite has another. */
  private ownGeneration: string | null = null;
  /**
   * The records at the front of a failed append that did reach the log whole, in order. The caller sends the same
   * batch again, and these are skipped: writing them twice would need room a full disk may not have.
   */
  private landed: Uint8Array[] = [];
  /** Changes in our own log that the document passed to start() lacked. */
  private ownMissing: Uint8Array | null = null;
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<void> | null = null;
  private rescan = false;
  private stopped = false;
  /**
   * The folder's real path and identity (device and inode) at start. It must stay a real directory that matches
   * either: the same real path (Dropbox may delete and recreate it), or the same directory (a folder above it renamed
   * only in case, which changes the real path macOS reports).
   */
  private realFolder: string | null = null;
  private folderId: { dev: number; ino: number } | null = null;
  /** Set once the folder fails its check: nothing in it is read or written after that. */
  private broken: UnsafeFileError | null = null;
  /**
   * Problems with single logs, for the writer: a log skipped as a link or special file (keyed by its name), and
   * records or whole logs skipped as unreadable (keyed by name and kind). A scan reports each one once.
   */
  private readonly refused = new Map<string, Error>();
  private readonly reported = new Set<string>();

  constructor(options: FolderSyncOptions) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(options.deviceId)) throw new Error("A device ID is 8 to 64 letters, digits, - or _.");
    this.options = options;
    this.folder = options.folder;
    this.deviceId = options.deviceId;
    this.ownLog = join(options.folder, `${options.deviceId}${LOG_EXTENSION}`);
  }

  /**
   * Create the folder, make sure our log holds everything in `state` (the document as this device has it), and
   * return every record the other devices have written so far, plus anything our own log has that `state` lacks
   * (changes logged before a crash or a close without saving, which the other devices already have). Then start
   * watching. Fails, writing nothing, when the folder is a link or not a directory.
   */
  async start(state?: Uint8Array): Promise<Uint8Array[]> {
    // lstat before mkdir: a link synced from another Mac usually points at a path missing here, and mkdir would
    // fail on it with a bare ENOENT instead of saying it is a link.
    let info = await lstat(this.folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) {
      await mkdir(this.folder, { recursive: true });
      info = await lstat(this.folder);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new UnsafeFileError(this.folder, `Folder sync is off for this script: ${basename(this.folder)} is ${info.isSymbolicLink() ? "a link" : "not a folder"}. `
        + "Only a real folder next to the script can sync. Remove it, then turn folder sync on again.");
    }
    this.realFolder = await realpath(this.folder);
    this.folderId = { dev: info.dev, ino: info.ino };
    await this.enqueue(() => this.prepareOwnLog(state));
    const updates = await this.readOthers();
    if (this.ownMissing) updates.unshift(this.ownMissing);
    this.ownMissing = null;
    // Stopped while starting (its window closed): stop() already ran, so nothing may start watching after it.
    if (this.stopped) return updates;
    if (this.options.watch !== false) {
      try {
        this.watcher = watch(this.folder, () => this.requestScan());
        this.watcher.on("error", () => undefined);
      } catch {
        // The rescan still delivers changes.
      }
    }
    this.timer = setInterval(() => this.requestScan(), this.options.rescanMs ?? 4000);
    this.timer.unref?.();
    // The window hears about skipped logs from the first scan, once it is listening.
    if (this.refused.size) this.requestScan();
    return updates;
  }

  /** Append local changes to our log. */
  append(updates: Uint8Array[]): Promise<void> {
    if (!updates.length) return this.queue;
    return this.enqueue(() => this.appendNow(updates));
  }

  /** Every record in every log, ours included, from the start: for a second window opening the same document. */
  async snapshot(): Promise<Uint8Array[]> {
    await this.queue;
    const updates: Uint8Array[] = [];
    if (!(await this.checkFolder())) return updates;
    for (const name of await this.logNames(true)) {
      try {
        const bytes = await this.readLog(name);
        if (bytes) updates.push(...this.updatesIn(name, parseLog(bytes).records));
      } catch (error) {
        this.skipUnreadable(name, error);
      }
    }
    return updates;
  }

  /** Read new records from the other devices now. Normally fs.watch and the timer call this. */
  scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.rescan = false;
        try {
          const updates = await this.readOthers();
          if (updates.length && !this.stopped) this.options.onUpdates(updates);
          for (const [key, error] of this.refused) {
            if (this.reported.has(key) || this.stopped) continue;
            this.reported.add(key);
            this.options.onError?.(error);
          }
        } catch (error) {
          if (!this.stopped) this.options.onError?.(error);
        }
      } while (this.rescan && !this.stopped);
      this.scanning = null;
    })();
    return this.scanning;
  }

  /** Stop watching. Pending appends finish first. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopWatching();
    clearTimeout(this.scanTimer);
    await this.queue;
  }

  private stopWatching(): void {
    this.watcher?.close();
    clearInterval(this.timer);
  }

  private requestScan(): void {
    if (this.stopped) return;
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => void this.scan(), 100);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task);
    this.queue = next.catch((error) => this.options.onError?.(error));
    return next;
  }

  /**
   * Whether the folder is still the real directory sync started in: false when it is gone (nothing to read). Once
   * it is a link, not a directory, or at another real path, this throws, stops watching, and keeps throwing, so
   * nothing in it is read or written again.
   */
  private async checkFolder(): Promise<boolean> {
    if (this.broken) throw this.broken;
    let info;
    try {
      info = await lstat(this.folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const real = info.isDirectory() && !info.isSymbolicLink() ? await realpath(this.folder).catch(() => null) : null;
    if (real !== null && (real === this.realFolder || (info.dev === this.folderId?.dev && info.ino === this.folderId.ino))) return true;
    const what = info.isSymbolicLink() ? "a link" : real === null ? "something that is not a folder" : "a folder somewhere else";
    this.broken = new UnsafeFileError(this.folder, `Folder sync stopped for this script: ${basename(this.folder)} was replaced by ${what}, `
      + "so nothing in it is read or written now. The script in this window is unchanged; save it, then check the folder.");
    this.stopWatching();
    throw this.broken;
  }

  private async logNames(includeOwn: boolean): Promise<string[]> {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    return names.filter((name) => name.endsWith(LOG_EXTENSION) && !name.startsWith(".") && (includeOwn || name !== basename(this.ownLog)));
  }

  /** A log's bytes, or null when it is gone, is a link or a special file, or is too large (noted for a warning). */
  private async readLog(name: string): Promise<Uint8Array | null> {
    let opened;
    try {
      opened = await openForRead(join(this.folder, name));
    } catch (error) {
      if (!isUnsafe(error)) throw error;
      this.refuse(name);
      return null;
    }
    if (!opened) return null;
    try {
      if (this.tooLarge(name, opened.info.size)) return null;
      // Only what the size check covered: the file can grow between the check and the read.
      const bytes = await opened.readFirst(opened.info.size);
      if (await this.stillHere(name, opened.info)) return bytes;
      this.refuse(name);
      return null;
    } finally {
      await opened.close();
    }
  }

  /**
   * Whether the folder is still the directory sync started in and `name` still names the file that was opened.
   * Node cannot open a file relative to a directory handle, so the folder is checked again after each open: a
   * co-writer who swapped the folder for a link to another script's folder would have to swap it back between
   * the open and this check for the read to count.
   */
  private async stillHere(name: string, opened: { dev: number; ino: number }): Promise<boolean> {
    if (!(await this.checkFolder())) return false;
    const now = await lstat(join(this.folder, name)).catch(() => null);
    return !!now && now.isFile() && now.dev === opened.dev && now.ino === opened.ino;
  }

  private refuse(name: string): void {
    if (this.refused.has(name)) return;
    const own = name === basename(this.ownLog);
    this.refused.set(name, new UnsafeFileError(join(this.folder, name), `${own ? "This Mac's own log" : `The log ${name}`} in ${basename(this.folder)} `
      + `is a link or not a regular file, so folder sync ${own ? "replaced it with a new log" : "skips it"}. Folder sync uses only real files inside the sync folder.`));
  }

  /** Note a problem with one log, to report once. `kind` keeps apart the different problems one log can have. */
  private warn(name: string, kind: string, message: string): void {
    const key = `${name}\0${kind}`;
    if (!this.refused.has(key)) this.refused.set(key, new Error(message));
  }

  /** Whether a log is too large to read. Its size comes from the open file, so nothing is read to find out. */
  private tooLarge(name: string, size: number): boolean {
    const limit = this.options.maxLogBytes ?? MAX_LOG_BYTES;
    if (size <= limit) return false;
    const own = name === basename(this.ownLog);
    this.warn(name, "size", `${own ? "This Mac's own log" : `The log ${name}`} in ${basename(this.folder)} is larger than `
      + `${Math.round(limit / (1024 * 1024))} MB, so folder sync ${own ? "does not read it and writes a new one" : "skips it"}. The other logs still sync.`);
    return true;
  }

  /**
   * One log failed to read (a disk or cloud error, a file that grew past what can be read at once). That is this
   * log's problem alone: the others are still read. The folder failing its check is not: that stops everything.
   */
  private skipUnreadable(name: string, error: unknown): void {
    if (error === this.broken) throw error;
    this.warn(name, "read", `Folder sync could not read the log ${name} in ${basename(this.folder)} `
      + `(${error instanceof Error ? error.message : String(error)}), so it skips it for now. The other logs still sync.`);
  }

  /**
   * The records that are Yjs updates. A record that is not one would throw where the updates are merged or applied
   * and take the good records beside it down too, so it is dropped here and the writer is told.
   */
  private updatesIn(name: string, records: Uint8Array[]): Uint8Array[] {
    const updates = records.filter(isUpdate);
    const skipped = records.length - updates.length;
    if (skipped) {
      const own = name === basename(this.ownLog);
      this.warn(name, "records", `${own ? "This Mac's own log" : `The log ${name}`} in ${basename(this.folder)} holds `
        + `${skipped === 1 ? "a record that is not a script change" : `${skipped} records that are not script changes`}, `
        + `so folder sync skipped ${skipped === 1 ? "it" : "them"}. The other changes still sync.`);
    }
    return updates;
  }

  private async readOthers(): Promise<Uint8Array[]> {
    const updates: Uint8Array[] = [];
    if (!(await this.checkFolder())) return updates;
    for (const name of await this.logNames(false)) {
      // Each log on its own: a log read before a failing one has already had its offset advanced, so losing the
      // batch to the failure would lose those records for good.
      try {
        updates.push(...(await this.readOther(name)));
      } catch (error) {
        this.skipUnreadable(name, error);
      }
    }
    return updates;
  }

  /** The new records in one other device's log. */
  private async readOther(name: string): Promise<Uint8Array[]> {
    let opened;
    try {
      opened = await openForRead(join(this.folder, name));
    } catch (error) {
      if (!isUnsafe(error)) throw error;
      this.refuse(name);
      return [];
    }
    if (!opened) return [];
    try {
      const { info } = opened;
      const known = this.readers.get(name);
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return [];
      if (this.tooLarge(name, info.size)) return [];
      // Only what the size check covered; anything appended since is read on the next scan.
      const bytes = await opened.readFirst(info.size);
      if (!(await this.stillHere(name, info))) {
        this.refuse(name);
        return [];
      }
      // A new generation (the owner compacted) or a shorter file means start over; repeats are harmless.
      const from = known && known.generation === generationOf(bytes) && bytes.length >= known.end ? known.end : 0;
      const parsed = parseLog(bytes, from);
      // The offset moves past a record that is not an update too: it will never become one.
      this.readers.set(name, { generation: parsed.generation, end: parsed.end, size: bytes.length, mtimeMs: info.mtimeMs });
      return this.updatesIn(name, parsed.records);
    } finally {
      await opened.close();
    }
  }

  private async prepareOwnLog(state?: Uint8Array): Promise<void> {
    await this.checkFolder();
    // A link or special file in our log's place is never read; the rewrite below, or the first append, replaces it.
    // A log that cannot be read, or holds records that are not updates, is treated like a damaged one: rewritten below.
    const name = basename(this.ownLog);
    const bytes = await this.readLog(name).catch((error) => (this.skipUnreadable(name, error), null));
    const parsed = bytes ? parseLog(bytes) : null;
    const records = parsed && !parsed.invalid ? parsed.records : [];
    const own = this.updatesIn(name, records);
    const merged = own.length ? mergeAll(own) : null;
    // Only what the log is missing: changes made while folder sync was off, or a log lost to a damaged file.
    const missing = state ? (merged ? Y.diffUpdate(state, Y.encodeStateVectorFromUpdate(merged)) : state) : null;
    const extra = missing && !(merged && addsNothing(missing, merged)) ? missing : null;
    const back = merged && state ? Y.diffUpdate(merged, Y.encodeStateVectorFromUpdate(state)) : null;
    this.ownMissing = back && !addsNothing(back, state!) ? back : null;
    const intact = bytes && parsed && !parsed.invalid && parsed.end === bytes.length && own.length === records.length;
    if (intact) {
      this.ownBytes = bytes.length;
      this.ownGeneration = parsed.generation;
      // A log that is already one merged record counts as the last rewrite, so a merged log past the limit is not
      // rewritten on the first append after every start. A log of several records keeps 0: otherwise each restart
      // would move the threshold up and a log reopened often would never compact.
      if (own.length <= 1) this.compactedBytes = bytes.length;
      this.ownRecords = own;
      if (extra) await this.appendNow([extra]);
    } else if (merged || extra) {
      // A torn last record (a crash mid-append) would block every reader behind it, and a record that is not an
      // update would be skipped by every reader on every read, so rewrite the log clean.
      await this.rewrite([...(merged ? [merged] : []), ...(extra ? [extra] : [])]);
    }
  }

  private async appendNow(updates: Uint8Array[]): Promise<void> {
    if (!this.ownBytes) {
      await this.rewrite(updates);
      return;
    }
    // Readers stop at a torn record, so a retry appended behind it would be unreadable. Cut the torn bytes off, which
    // needs no free space (the disk is often full by now); if that cannot be done, write a clean log instead.
    let repaired: Awaited<ReturnType<FolderSync["cutTornTail"]>> = null;
    if (this.tornTail) {
      repaired = await this.cutTornTail().catch(() => null);
      if (!repaired) {
        await this.rewrite([mergeAll([...this.ownRecords, ...updates])]);
        return;
      }
    }
    // The front of a batch that failed before may already be in the log. The same records come again, so skip the
    // ones known to be there: the retry then needs room only for what is missing.
    let skip = 0;
    while (skip < this.landed.length && skip < updates.length && sameBytes(updates[skip]!, this.landed[skip]!)) skip++;
    updates = updates.slice(skip);
    await this.checkFolder();
    const records = encodeRecords(updates);
    let appended: boolean;
    try {
      // After a repair, only into the file that was repaired, at the length it was cut to: a copy that sync put in
      // its place since may still end in the torn record. Anything else counts as not appended, and is rewritten.
      appended = await appendRegular(this.ownLog, records, repaired?.file);
      if (appended) {
        this.ownRecords.push(...updates);
        this.landed = [];
      }
    } catch (error) {
      if (!isUnsafe(error)) {
        this.tornTail = true;
        throw error;
      }
      this.refuse(basename(this.ownLog));
      appended = false;
    }
    if (!appended) {
      // Our log was removed, or replaced by a link, a special file, a second name for another file, or (after a
      // repair) another copy: start a new log rather than write through it, holding what the old one held too.
      // Whatever is at the path is not known to end cleanly, so if this rewrite fails the next append must repair
      // or rewrite first, and not append behind it.
      this.tornTail = true;
      await this.rewrite(this.ownRecords.length ? [mergeAll([...this.ownRecords, ...updates])] : updates);
      if (this.refused.has(basename(this.ownLog))) this.requestScan();
      return;
    }
    this.ownBytes += records.length;
    // A merged log can itself be larger than the limit (a long script with history), so leave room to grow
    // instead of rewriting the whole file, and making every other device re-read it, on each append.
    // The changes are in the log by now, so a failed compaction is only reported: failing the append would have
    // the caller write them a second time.
    if (this.ownBytes > Math.max(this.options.compactBytes ?? 1024 * 1024, 2 * this.compactedBytes)) {
      await this.compact().catch((error) => this.options.onError?.(error));
    }
  }

  /**
   * Cut our log back to the end of its last whole record, dropping the part of a record a failed append left. Whole
   * records that append did write stay: another Mac may already have read past them, and in a log nobody has
   * tampered with its offset then never lands inside the next record. Null, changing nothing, when the log is not one this device can repair: gone, a link,
   * replaced since it was read, of another generation or shorter than what this device last wrote (an older copy
   * synced back in). Otherwise the file that was repaired and the length it now has.
   */
  private async cutTornTail(): Promise<{ file: { dev: number; ino: number; size: number } } | null> {
    await this.checkFolder();
    const name = basename(this.ownLog);
    let opened;
    try {
      opened = await openForRead(this.ownLog);
    } catch (error) {
      if (!isUnsafe(error)) throw error;
      this.refuse(name);
      return null;
    }
    if (!opened) return null;
    let bytes: Uint8Array;
    try {
      if (this.tooLarge(name, opened.info.size)) return null;
      bytes = await opened.readFirst(opened.info.size);
      if (!(await this.stillHere(name, opened.info))) {
        this.refuse(name);
        return null;
      }
    } finally {
      await opened.close();
    }
    const parsed = parseLog(bytes);
    if (parsed.invalid || parsed.generation !== this.ownGeneration || parsed.end < this.ownBytes) return null;
    if (parsed.end < bytes.length && !(await truncateRegular(this.ownLog, parsed.end, opened.info))) return null;
    // Whole records the failed append wrote are in the log, so they count as written from here on, and the retry
    // of that batch skips them.
    const landed = parseLog(bytes, this.ownBytes).records;
    this.ownRecords.push(...landed);
    this.landed.push(...landed);
    this.ownBytes = parsed.end;
    this.tornTail = false;
    return { file: { dev: opened.info.dev, ino: opened.info.ino, size: parsed.end } };
  }

  private async compact(): Promise<void> {
    const bytes = await this.readLog(basename(this.ownLog));
    if (!bytes) return;
    const parsed = parseLog(bytes);
    // A failed append (a full disk) can leave a torn record with later appends behind it. Reading stops at the
    // torn one, so add what this device wrote, or the changes behind it would be lost. The records read before it
    // stay too: the failed append may have written some whole ones that never reached ownRecords. Merging the same
    // Yjs update twice is harmless.
    const whole = !parsed.invalid && parsed.end === bytes.length;
    const read = this.updatesIn(basename(this.ownLog), parsed.records);
    const records = whole ? read : [...read, ...this.ownRecords];
    if (records.length > 1 || (!whole && records.length)) await this.rewrite([mergeAll(records)]);
  }

  /**
   * Replace our log with a fresh generation holding these updates. Temporary names start with "." so readers skip
   * them, and are random and created only if free, so nothing planted at the name is written through. The rename
   * replaces whatever is at our log's name, a link included, without following it.
   */
  private async rewrite(updates: Uint8Array[]): Promise<void> {
    await this.checkFolder();
    const header = encodeHeader();
    const records = encodeRecords(updates);
    const out = new Uint8Array(header.length + records.length);
    out.set(header, 0);
    out.set(records, header.length);
    const temp = join(this.folder, `.${basename(this.ownLog)}.${randomSuffix()}.tmp`);
    await writeNewFile(temp, out);
    try {
      await rename(temp, this.ownLog);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    this.ownBytes = out.length;
    this.ownGeneration = generationOf(out);
    this.compactedBytes = out.length;
    this.ownRecords = [...updates];
    this.tornTail = false;
    this.landed = [];
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Whether a record is a Yjs update. A valid checksum does not show that: anyone who can write the folder can make one. */
export function isUpdate(record: Uint8Array): boolean {
  try {
    Y.decodeUpdate(record);
    return true;
  } catch {
    return false;
  }
}

/**
 * One update holding all of these. Updates that each decode can still fail to merge if one was crafted to, so on a
 * failure they are applied to a scratch document one at a time and whatever applies is kept.
 */
function mergeAll(updates: Uint8Array[]): Uint8Array {
  try {
    return Y.mergeUpdates(updates);
  } catch {
    const doc = new Y.Doc({ gc: false });
    for (const update of updates) {
      try {
        Y.applyUpdate(doc, update);
      } catch {
        // Skipped: the rest still count.
      }
    }
    const merged = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return merged;
  }
}

/**
 * Whether `update` holds nothing `base` lacks. A diff always carries the whole delete set, so a diff with no new
 * items is not empty; without this check every start would append the same deletions again.
 */
function addsNothing(update: Uint8Array, base: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update);
  if (structs.length) return false;
  const known = Y.decodeUpdate(base).ds.clients;
  for (const [client, deletes] of ds.clients) {
    const have = known.get(client) ?? [];
    for (const item of deletes) {
      if (!have.some((range) => range.clock <= item.clock && item.clock + item.len <= range.clock + range.len)) return false;
    }
  }
  return true;
}
