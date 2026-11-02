import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { noticeText, packChecksum, safeRelative, validateVoicePack, type VoicePack } from "./voice-manifest.ts";

import type { VoicePackState } from "../../shared/channels/table-read.ts";
export type { VoicePackState } from "../../shared/channels/table-read.ts";
export interface InstallProgress { packId: string; completedBytes: number; totalBytes: number; }
export async function fileSHA256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const NOTICE_PATH = "notices/NOTICE.txt";
export class VoiceModelManager {
  private readonly busy = new Set<string>();
  private readonly verified = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; ino: number; checksum: string }>();
  readonly root: string;
  readonly packs: VoicePack[];
  private readonly fetchFile: typeof fetch;
  constructor(root: string, packs: VoicePack[], fetchFile: typeof fetch = fetch) {
    this.root = root; this.packs = packs; this.fetchFile = fetchFile;
  }
  pack(id: string): VoicePack {
    const pack = this.packs.find((p) => p.id === id);
    if (!pack || !/^[a-z0-9-]+$/.test(id)) throw new Error("Unknown voice pack.");
    return pack;
  }
  private async directory(path: string): Promise<void> {
    // Check every component within the owned root, including existing parents of nested model files.
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const relative = path.slice(this.root.length).split("/").filter(Boolean);
    let current = this.root;
    for (const component of ["", ...relative]) {
      if (component) current = join(current, component);
      await mkdir(current, { recursive: true, mode: 0o700 });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe voice model directory.");
    }
  }
  /** Walks an existing directory chain without creating anything. */
  private async existingDirectory(path: string): Promise<void> {
    const relative = path.slice(this.root.length).split("/").filter(Boolean);
    let current = this.root;
    for (const component of ["", ...relative]) {
      if (component) current = join(current, component);
      const info = await lstat(current).catch(() => null);
      if (!info) throw new Error("Voice model verification failed: this voice pack is not installed.");
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe voice model directory.");
    }
  }
  private async matches(path: string, size: number, checksum: string): Promise<boolean> {
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== size) return false;
    const previous = this.verified.get(path);
    if (previous?.size === size && previous.mtimeMs === info.mtimeMs && previous.ctimeMs === info.ctimeMs
      && previous.ino === info.ino && previous.checksum === checksum) return true;
    if (await fileSHA256(path) !== checksum) { this.verified.delete(path); return false; }
    this.verified.set(path, { size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, checksum });
    return true;
  }
  /**
   * Folders were once named by a hash of the whole manifest, so a memory or license edit orphaned a finished
   * install. If the current folder is missing, adopt a sibling whose every file matches the pinned sizes and hashes.
   */
  private async adoptEarlierFolder(pack: VoicePack): Promise<void> {
    const parent = join(this.root, pack.id), target = join(parent, packChecksum(pack));
    // Nothing is renamed until the root and the pack folder are real directories inside the owned root.
    if (!await lstat(parent).catch(() => null)) return;
    await this.existingDirectory(parent);
    if ((await readdir(target).catch(() => [])).length) return;
    for (const name of await readdir(parent).catch(() => [] as string[])) {
      const folder = join(parent, name);
      if (folder === target || !/^[a-f0-9]{64}$/.test(name)) continue;
      const info = await lstat(folder).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      let complete = true;
      for (const file of pack.files) {
        const inside = await this.existingDirectory(dirname(join(folder, file.localPath))).then(() => true, () => false);
        if (!inside || !await this.matches(join(folder, file.localPath), file.size, file.sha256)) { complete = false; break; }
      }
      if (complete) { await rename(folder, target).catch(() => undefined); return; }
    }
  }
  /** The notice is generated from the manifest, so a missing or older one is rewritten rather than failing a verified install. */
  private async writeNotice(root: string, pack: VoicePack): Promise<void> {
    const noticePath = join(root, NOTICE_PATH);
    if (await readFile(noticePath, "utf8").catch(() => null) === noticeText(pack)) return;
    await this.directory(dirname(noticePath));
    // A unique temp name per writer: two windows verifying at once must not share one file.
    const temporary = `${noticePath}.${randomUUID()}.part`;
    try {
      await writeFile(temporary, noticeText(pack), { mode: 0o600, flag: "wx" }); await rename(temporary, noticePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      // Another writer may already have put the correct notice in place.
      if (await readFile(noticePath, "utf8").catch(() => null) !== noticeText(pack)) throw error;
    }
  }
  async verifiedDirectory(id: string): Promise<string> {
    const pack = this.pack(id); validateVoicePack(pack);
    await this.adoptEarlierFolder(pack);
    const root = join(this.root, pack.id, packChecksum(pack));
    await this.existingDirectory(root);
    const allowed = new Set(pack.files.map((file) => file.localPath));
    allowed.add(NOTICE_PATH);
    if (pack.engine === "qwen" || pack.engine === "qwen-design") allowed.add("tokenizer.json");
    if (pack.engine === "kokoro") for (const file of pack.files) {
      const voice = /^kokoro\/voices\/([ab][fm]_\w+)\.json$/.exec(file.localPath)?.[1];
      if (voice) allowed.add(`kokoro-82m-coreml/ANE/${voice}.bin`);
    }
    const inspect = async (directory: string, prefix = ""): Promise<void> => {
      for (const name of await readdir(directory)) {
        const relative = prefix + name, path = join(directory, name), info = await lstat(path).catch(() => null);
        if (!info) continue; // another writer's temp file finished between listing and inspection
        if (info.isSymbolicLink()) throw new Error("Unsafe voice model asset.");
        if (info.isDirectory()) await inspect(path, relative + "/");
        else if (!allowed.has(relative) && !relative.endsWith(".part") && name !== ".DS_Store") {
          throw new Error(`Unverified voice model asset: ${relative}`);
        }
      }
    };
    await inspect(root);
    for (const file of pack.files) {
      await this.existingDirectory(dirname(join(root, file.localPath))).catch(() => { throw new Error(`Voice model verification failed: ${file.localPath}. Install the pack again.`); });
      if (!await this.matches(join(root, file.localPath), file.size, file.sha256)) {
        throw new Error(`Voice model verification failed: ${file.localPath}. Install the pack again.`);
      }
    }
    await this.writeNotice(root, pack);
    return root;
  }
  async states(): Promise<VoicePackState[]> {
    const usage = async (path: string): Promise<number> => {
      const info = await lstat(path).catch(() => null);
      if (!info || info.isSymbolicLink()) return 0;
      if (info.isFile()) return info.size;
      if (!info.isDirectory()) return 0;
      return (await Promise.all((await readdir(path)).map((name) => usage(join(path, name))))).reduce((a, b) => a + b, 0);
    };
    return Promise.all(this.packs.map(async (pack) => ({
      id: pack.id, label: pack.label, engine: pack.engine,
      installed: await this.verifiedDirectory(pack.id).then(() => true, () => false),
      sizeBytes: pack.files.reduce((n, f) => n + f.size, 0), diskBytes: await usage(join(this.root, pack.id)),
      minimumMacOS: pack.minimumMacOS, memoryGB: pack.memoryGB, license: pack.license,
      licenseUrls: pack.sources.flatMap((source, index) => {
        const notices = pack.files.filter((file) => file.source === index && /(?:^|\/)(?:LICENSE[^/]*|NOTICE[^/]*)$/i.test(file.path));
        return (notices.length ? notices.map((file) => file.path) : ["README.md"]).map((path) =>
          `https://huggingface.co/${source.repo}/blob/${source.revision}/${path.split("/").map(encodeURIComponent).join("/")}`);
      }),
      provenance: pack.provenance, revision: pack.sources.map((s) => s.revision), unresolved: pack.unresolved
    })));
  }
  async install(id: string, consent: boolean, signal: AbortSignal, progress?: (p: InstallProgress) => void): Promise<void> {
    if (!consent) throw new Error("Confirm the voice pack size and requirements before downloading.");
    const pack = this.pack(id); validateVoicePack(pack);
    if (this.busy.has(id)) throw new Error("This voice pack is already being changed.");
    this.busy.add(id);
    try {
      await this.adoptEarlierFolder(pack);
      const root = join(this.root, pack.id, packChecksum(pack)); await this.directory(root);
      const totalBytes = pack.files.reduce((n, f) => n + f.size, 0);
      let remainingBytes = 0;
      for (const file of pack.files) {
        const path = join(root, file.localPath);
        await this.directory(dirname(path));
        if (await this.matches(path, file.size, file.sha256)) continue;
        const partial = await lstat(`${path}.part`).catch(() => null);
        const retained = partial?.isFile() && !partial.isSymbolicLink() && partial.size <= file.size ? partial.size : 0;
        remainingBytes += file.size - retained;
      }
      const disk = await statfs(root);
      if (disk.bavail * disk.bsize < remainingBytes) throw new Error("Not enough free disk space for this voice pack.");
      let completedBytes = 0;
      for (const file of pack.files) {
        signal.throwIfAborted();
        const path = join(root, file.localPath), part = `${path}.part`;
        await this.directory(dirname(path));
        if (await this.matches(path, file.size, file.sha256)) { completedBytes += file.size; continue; }
        await rm(path, { force: true });
        const info = await lstat(part).catch(() => null);
        if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Unsafe partial voice download.");
        let offset = info?.size ?? 0;
        if (offset > file.size) { await rm(part); offset = 0; }
        if (offset < file.size) {
          const source = pack.sources[file.source]!;
          const url = `https://huggingface.co/${source.repo}/resolve/${source.revision}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
          const response = await this.fetchFile(url, { signal, headers: offset ? { Range: `bytes=${offset}-` } : {} });
          if (!response.ok || !response.body) throw new Error(`Voice download failed (${response.status}). Retry to resume.`);
          if (offset && response.status === 206) {
            if (response.headers.get("content-range") !== `bytes ${offset}-${file.size - 1}/${file.size}`) throw new Error("Invalid voice download range.");
          } else if (response.status === 200) { offset = 0; }
          else throw new Error("Invalid voice download response.");
          const handle = await open(part, offset ? "a" : "w", 0o600);
          let received = offset;
          try {
            for await (const chunk of response.body) {
              signal.throwIfAborted(); received += chunk.byteLength;
              if (received > file.size) throw new Error("Voice download exceeds the manifest size.");
              let written = 0;
              while (written < chunk.byteLength) {
                const result = await handle.write(chunk, written, chunk.byteLength - written);
                if (!result.bytesWritten) throw new Error("Voice download could not be written to disk.");
                written += result.bytesWritten;
              }
              progress?.({ packId: id, completedBytes: completedBytes + received, totalBytes });
            }
          } finally { await handle.close(); }
        }
        if (!await this.matches(part, file.size, file.sha256)) {
          await rm(part, { force: true }); throw new Error("Voice checksum mismatch. The model will not be loaded.");
        }
        await rename(part, path); completedBytes += file.size;
        progress?.({ packId: id, completedBytes, totalBytes });
      }
      // The license and attribution notice is generated from the pinned manifest, then checked on every verification.
      await this.writeNotice(root, pack);
      await this.verifiedDirectory(id);
      progress?.({ packId: id, completedBytes: totalBytes, totalBytes });
    } finally { this.busy.delete(id); }
  }
  async remove(id: string): Promise<void> {
    this.pack(id);
    if (this.busy.has(id)) throw new Error("This voice pack is already being changed.");
    if (!safeRelative(id)) throw new Error("Invalid voice pack.");
    this.busy.add(id);
    try {
      await rm(join(this.root, id), { recursive: true, force: true });
      for (const path of this.verified.keys()) if (path.startsWith(join(this.root, id) + "/")) this.verified.delete(path);
    } finally { this.busy.delete(id); }
  }
}
