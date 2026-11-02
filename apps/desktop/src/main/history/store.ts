import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { HISTORY_LIMITS, type HistoryEntry, type HistoryRecord } from "../../shared/channels/history.ts";
import { isRealDirectory, openForRead, replaceFile, writeNewFile } from "../safe-fs.ts";

const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(value);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
type StoredEntry = HistoryEntry & { stateHash: string };
interface Index { version: 1; entries: StoredEntry[]; }

/** No caller-supplied path ever reaches the file system. Keys and entry IDs are opaque identifiers. */
export class HistoryStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly root: string;
  constructor(root: string) { this.root = root; }
  private async folder(key: string): Promise<string> {
    if (!validId(key)) throw new Error("Invalid document history identifier.");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!isRealDirectory(this.root)) throw new Error("The history folder is not a normal directory.");
    const path = join(this.root, key);
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if (!isRealDirectory(path)) throw new Error("The document history folder is not a normal directory.");
    return path;
  }
  private async bytes(path: string, limit: number): Promise<Uint8Array | null> {
    const file = await openForRead(path);
    if (!file) return null;
    try {
      if (file.info.size > limit) throw new Error("A history file exceeds the storage limit.");
      return await file.read();
    } finally { await file.close(); }
  }
  private async index(folder: string): Promise<Index> {
    const bytes = await this.bytes(join(folder, "index.json"), 256_000);
    if (!bytes) return { version: 1, entries: [] };
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Index;
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > HISTORY_LIMITS.entries || value.entries.some((e) =>
      !e || !validId(e.id) || typeof e.label !== "string" || e.label.length > 160 || !Number.isFinite(Date.parse(e.at)) ||
      !Number.isInteger(e.bytes) || e.bytes < 12 || e.bytes > HISTORY_LIMITS.snapshotBytes || typeof e.named !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(e.hash) || !/^[a-f0-9]{64}$/.test(e.stateHash))) {
      throw new Error("The history index is damaged. Existing snapshots have been left untouched.");
    }
    return value;
  }
  private async persist(folder: string, index: Index): Promise<void> {
    await replaceFile(join(folder, "index.json"), join(folder, `index-${randomUUID()}.tmp`), JSON.stringify(index), 0o600);
  }
  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.queues.set(key, pending);
    void pending.finally(() => { if (this.queues.get(key) === pending) this.queues.delete(key); }).catch(() => undefined);
    return pending;
  }
  async list(key: string): Promise<HistoryEntry[]> {
    await this.queues.get(key)?.catch(() => undefined);
    return (await this.index(await this.folder(key))).entries.map(({ stateHash: _, ...entry }) => entry);
  }
  async record(request: HistoryRecord): Promise<HistoryEntry> {
    if (!request || !validId(request.documentId) || typeof request.label !== "string" || request.label.length > 160 || typeof request.named !== "boolean" ||
      !(request.data instanceof Uint8Array) || request.data.length < 13 || request.data.length > HISTORY_LIMITS.snapshotBytes) throw new Error("Invalid or oversized history snapshot.");
    const data = new Uint8Array(request.data); // Never observe a caller mutating an in-flight snapshot.
    if (new TextDecoder().decode(data.subarray(0, 8)) !== "SCRNPLY1") throw new Error("History accepts native screenplay snapshots only.");
    const end = 12 + new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8, false);
    if (end >= data.length || end > 65548) throw new Error("The snapshot header is invalid.");
    const header = JSON.parse(new TextDecoder().decode(data.subarray(12, end)));
    if (header.format !== 1 || typeof header.schema !== "number") throw new Error("The snapshot header is invalid.");
    return this.serialize(request.documentId, async () => {
      const folder = await this.folder(request.documentId), index = await this.index(folder);
      const stateHash = sha(data.subarray(end));
      if (!request.named && index.entries[0]?.stateHash === stateHash) return index.entries[0];
      if (request.named && index.entries.filter((e) => e.named).length >= HISTORY_LIMITS.named) throw new Error("Twenty named snapshots are already kept. Remove an unwanted named snapshot before creating another.");
      const entry: StoredEntry = { id: randomUUID(), at: new Date().toISOString(), label: request.label.trim() || "Automatic snapshot", named: request.named, bytes: data.length, hash: sha(data), stateHash };
      const entries = [entry, ...index.entries], removed: StoredEntry[] = [];
      let total = entries.reduce((n, e) => n + e.bytes, 0);
      while (entries.length > HISTORY_LIMITS.entries || total > HISTORY_LIMITS.documentBytes) {
        let at = entries.length - 1;
        while (at > 0 && entries[at]!.named) at--;
        if (at === 0) throw new Error("Named snapshots fill the history budget. Remove an unwanted named snapshot first.");
        const [old] = entries.splice(at, 1); total -= old!.bytes; removed.push(old!);
      }
      await writeNewFile(join(folder, `${entry.id}.screenplay`), data, 0o600);
      try { await this.persist(folder, { version: 1, entries }); }
      catch (error) { await rm(join(folder, `${entry.id}.screenplay`), { force: true }); throw error; }
      // Publish the safe index before removing only obsolete automatic snapshots.
      for (const old of removed) await rm(join(folder, `${old.id}.screenplay`), { force: true }).catch(() => undefined);
      return entry;
    });
  }
  async read(key: string, id: string): Promise<Uint8Array> {
    if (!validId(id)) throw new Error("Invalid snapshot identifier.");
    await this.queues.get(key)?.catch(() => undefined);
    const folder = await this.folder(key), entry = (await this.index(folder)).entries.find((e) => e.id === id);
    if (!entry) throw new Error("This snapshot is no longer in history.");
    const data = await this.bytes(join(folder, `${id}.screenplay`), HISTORY_LIMITS.snapshotBytes);
    if (!data || data.length !== entry.bytes || sha(data) !== entry.hash) throw new Error("This snapshot failed its integrity check; the current draft was not changed.");
    return data;
  }
  async remove(key: string, id: string): Promise<void> {
    if (!validId(id)) throw new Error("Invalid snapshot identifier.");
    return this.serialize(key, async () => {
      const folder = await this.folder(key), index = await this.index(folder);
      if (!index.entries.some((e) => e.id === id)) return;
      await this.persist(folder, { version: 1, entries: index.entries.filter((e) => e.id !== id) });
      await rm(join(folder, `${id}.screenplay`), { force: true });
    });
  }
}
