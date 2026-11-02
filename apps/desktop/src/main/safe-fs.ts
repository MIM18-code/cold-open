// File access that a shared folder cannot redirect. Folder sync reads and writes inside a folder other people can
// change (a Dropbox folder shared with a co-writer), and a script may sit in one. A link planted there must never
// make this Mac read or write a file outside it, and a FIFO must never hang the main process. So these helpers:
// - open with O_NOFOLLOW (where the platform has it), so a link in the last path component fails instead of being
//   followed, and with O_NONBLOCK, so opening a FIFO returns at once;
// - check the open descriptor with fstat and use it only if it is a regular file (with one name, when links are
//   refused);
// - create new files with O_CREAT | O_EXCL, which never follows a link and never reuses a file someone planted.
// No Electron here, so tests drive it directly.
import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/** A path that is a link, or not a regular file, where only a regular file may be used. */
export class UnsafeFileError extends Error {
  readonly code = "EUNSAFE";
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/**
 * Open a regular file. `follow` false refuses a link in the last component (ELOOP from O_NOFOLLOW; an lstat first
 * where the platform lacks it) and a hard link. Resolves to null when nothing is there (ENOENT).
 */
async function openRegular(path: string, flags: number, follow: boolean): Promise<FileHandle | null> {
  if (!follow && !NOFOLLOW) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new UnsafeFileError(path, `${basename(path)} is a link.`);
    } catch (error) {
      if (errno(error) === "ENOENT") return null;
      throw error;
    }
  }
  let handle: FileHandle;
  try {
    handle = await open(path, flags | NONBLOCK | (follow ? 0 : NOFOLLOW));
  } catch (error) {
    const code = errno(error);
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new UnsafeFileError(path, `${basename(path)} is a link.`);
    // A FIFO with no reader (opened for writing) or a socket.
    if (code === "ENXIO" || code === "EOPNOTSUPP") throw new UnsafeFileError(path, `${basename(path)} is not a regular file.`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new UnsafeFileError(path, `${basename(path)} is not a regular file.`);
    // A hard link is a second name for a file elsewhere: reads would bring that file in, writes would change it.
    if (!follow && info.nlink > 1) throw new UnsafeFileError(path, `${basename(path)} is a second name for another file.`);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

export interface OpenedRegular {
  info: Stats;
  read(maximum?: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Open a regular file for reading without following a link. Null when there is none. */
export async function openForRead(path: string): Promise<OpenedRegular | null> {
  const handle = await openRegular(path, constants.O_RDONLY, false);
  if (!handle) return null;
  const info = await handle.stat();
  return {
    info,
    read: async (maximum?: number) => {
      if (maximum === undefined) return new Uint8Array(await handle.readFile());
      const bytes = Buffer.alloc(maximum + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > maximum) throw new Error(`${basename(path)} exceeds its size limit.`);
      return new Uint8Array(bytes.subarray(0, offset));
    },
    close: () => handle.close(),
  };
}

/** Read a regular file without following a link. Null when there is none. */
export async function readRegular(path: string): Promise<Uint8Array | null> {
  const opened = await openForRead(path);
  if (!opened) return null;
  try {
    return await opened.read();
  } finally {
    await opened.close();
  }
}

/**
 * Read a file the writer chose (a link they chose is followed), refusing anything but a regular file, so a FIFO
 * or a device never blocks the main process.
 */
export async function readChosenFile(path: string): Promise<Uint8Array> {
  const handle = await openRegular(path, constants.O_RDONLY, true);
  if (!handle) throw Object.assign(new Error(`${basename(path)} can't be found.`), { code: "ENOENT" });
  try {
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

/**
 * Append to an existing regular file without following a link. False when the file is not there; throws
 * UnsafeFileError for a link, a special file, or a file with a second name.
 */
export async function appendRegular(path: string, data: Uint8Array): Promise<boolean> {
  const handle = await openRegular(path, constants.O_WRONLY | constants.O_APPEND, false);
  if (!handle) return false;
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  return true;
}

/** Create a file that does not exist yet and write it. Anything already at the path, a link included, fails with EEXIST. */
export async function writeNewFile(path: string, data: Uint8Array | string, mode = 0o666): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try {
    await handle.writeFile(data);
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
}

/**
 * Replace `destination` with `data`: a new file at `temp`, renamed over it. Rename replaces whatever is at the
 * destination, a link included, and never writes through it.
 */
export async function replaceFile(destination: string, temp: string, data: Uint8Array | string, mode?: number): Promise<void> {
  await writeNewFile(temp, data, mode);
  try {
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** A random suffix for temporary names, so nobody can plant a file at the name before it is written. */
export function randomSuffix(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether `path` is a real folder: a directory that is not a link. */
export function isRealDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether `path` itself is a link. */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The real path, or null when it cannot be resolved (missing, or a dangling link). */
export function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Where the path itself sits on disk: its folder's real path plus its own name. A link here is not followed. */
export function realLocation(path: string): string | null {
  const folder = realOrNull(dirname(path));
  return folder === null ? null : join(folder, basename(path));
}
