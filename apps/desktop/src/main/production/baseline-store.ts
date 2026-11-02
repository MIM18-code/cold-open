import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BASELINE_LIMIT, isSavedProductionBaseline, type SavedProductionBaseline } from "../../shared/channels/production-baseline.ts";
import { openForRead, replaceFile } from "../safe-fs.ts";

interface StoredBaseline { path: string; value: SavedProductionBaseline }
const entryName = (name: string) => /^[a-f0-9]{64}\.json$/.test(name);

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

export function productionPathKey(path: unknown): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.length > 32768)
    throw new Error("Invalid script path.");
  return createHash("sha256").update(resolve(path)).digest("hex");
}

export class ProductionBaselineStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly root: string;
  constructor(root: string) { this.root = root; }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(action);
    this.tail = next;
    return next;
  }

  private async location(path: string): Promise<string> {
    const key = productionPathKey(path);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const location = join(await realpath(dirname(resolve(this.root))), basename(resolve(this.root)));
    if (await realpath(this.root) !== location) throw new Error("The production baseline folder cannot be redirected.");
    return join(this.root, key + ".json");
  }

  private async read(path: string): Promise<StoredBaseline | null> {
    const file = await openForRead(path);
    if (!file) return null;
    try {
      if (file.info.size > BASELINE_LIMIT) throw new Error("The saved production baseline exceeds its limit.");
      const stored = JSON.parse(new TextDecoder().decode(await file.read(BASELINE_LIMIT))) as StoredBaseline | null;
      if (!isSavedProductionBaseline(stored?.value) || productionPathKey(stored?.path) + ".json" !== basename(path))
        throw new Error("The saved production baseline is damaged.");
      return stored;
    } finally { await file.close(); }
  }

  get(path: string): Promise<SavedProductionBaseline | null> {
    productionPathKey(path);
    return this.run(async () => (await this.read(await this.location(path)))?.value ?? null);
  }

  private async prune(): Promise<void> {
    for (const name of (await readdir(this.root)).filter(entryName)) {
      const path = join(this.root, name), stored = await this.read(path).catch(() => null);
      // Gone only when its folder is still there; a missing folder may be a drive that is not mounted right now.
      if (stored && await pathExists(dirname(stored.path)).catch(() => false) && !await pathExists(stored.path).catch(() => true))
        await rm(path, { force: true });
    }
  }

  set(path: string, value: unknown): Promise<void> {
    productionPathKey(path);
    if (value !== null && !isSavedProductionBaseline(value)) throw new Error("Invalid production baseline.");
    const data = JSON.stringify(value === null ? null : { path: resolve(path), value } satisfies StoredBaseline);
    if (Buffer.byteLength(data) > BASELINE_LIMIT) throw new Error("The saved production baseline exceeds its limit.");
    return this.run(async () => {
      const destination = await this.location(path);
      if (value === null) await rm(destination, { force: true });
      else {
        if (!await pathExists(resolve(path))) throw new Error("Save the script before storing its production baseline.");
        await this.prune();
        await replaceFile(destination, destination + "." + randomUUID() + ".saving", data, 0o600);
      }
    });
  }

  async flush(): Promise<void> { await this.tail; }
}
