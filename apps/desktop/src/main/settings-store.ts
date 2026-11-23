// The settings file. Kept apart from context.ts, which needs Electron, so tests can load it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** User settings in userData/settings.json. Keys are namespaced by feature: "ai.provider", "editor.zoom". */
export class Settings {
  // No prototype: a page names keys (settings:set), and "__proto__" on a plain object would swap its prototype, so
  // every lookup, grants.* included, would inherit what the page sent.
  private values: Record<string, unknown> = Object.create(null);
  private readonly file: string;
  private readonly listeners = new Set<(key: string, value: unknown) => void>();

  constructor(file: string) {
    this.file = file;
    try {
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) Object.assign(this.values, saved);
    } catch {
      // No settings yet.
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return (Object.hasOwn(this.values, key) ? this.values[key] : undefined) as T | undefined;
  }

  all(): Record<string, unknown> {
    return structuredClone({ ...this.values });
  }

  set(key: string, value: unknown): void {
    // Memory changes only once the file has the change: a value JSON cannot hold (a BigInt or a cycle, both of which
    // arrive over IPC) or a failed write would otherwise leave memory ahead of disk, and the bad value would make
    // every later save throw too.
    const next: Record<string, unknown> = Object.assign(Object.create(null), this.values);
    if (value === undefined || value === null) delete next[key];
    else next[key] = value;
    const text = JSON.stringify(next, null, 2);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, text);
    renameSync(temp, this.file);
    this.values = next;
    for (const listener of this.listeners) listener(key, value);
  }

  onChange(listener: (key: string, value: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
