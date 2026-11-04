import { lstatSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, unlink, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { openForRead } from "../safe-fs.ts";
import { receiptId, type PhoneDevices } from "./devices.ts";
import type { PhoneInboxStore } from "./inbox.ts";
import type { PhoneInbox, PhoneSnapshot } from "../../shared/channels/phone.ts";

// The folder name is shared with the iPhone app and already exists in writers' iCloud, so it keeps the old app name.
const INBOX_FOLDER = "Inklot Phone Inbox";
export type TakeVerifier = (deviceId: string, scriptId: string, item: PhoneInbox, sig: unknown) => boolean;
export function validateFolderItem(value: unknown, deviceId: string, scriptId: string,
    verify: TakeVerifier): PhoneInbox {
  const item = value as Record<string, unknown> | null;
  if (!item || item.v !== (typeof item.kind === "string" && item.kind.startsWith("scene-") ? 2 : 1) || item.deviceId !== deviceId || item.scriptId !== scriptId
      || typeof item.id !== "string" || !receiptId.test(item.id)
      || !["scene-after", "scene-end", "draft", "note", "dictation"].includes(item.kind as string)
      || typeof item.text !== "string" || !item.text.trim() || item.text.length > 20000
      || typeof item.paragraphId !== "string" || !item.paragraphId.trim() && item.kind !== "note" || item.paragraphId.length > 160
      || typeof item.sourceText !== "string" || item.sourceText.length > 1500
      || Buffer.byteLength(JSON.stringify({ id: item.id, kind: item.kind, text: item.text,
        paragraphId: item.paragraphId, sourceText: item.sourceText })) > 24000)
    throw new Error("Invalid phone inbox file.");
  const inbox: PhoneInbox = { id: item.id, deviceId, kind: item.kind as PhoneInbox["kind"], text: item.text,
    paragraphId: item.paragraphId, sourceText: item.sourceText, cueId: "", revision: "phone-folder",
    created: new Date().toISOString() };
  if (!verify(deviceId, scriptId, inbox, item.sig))
    throw new Error("Invalid phone take signature. The file could not be authenticated to a remembered iPhone.");
  return inbox;
}

export interface FolderGrant { path: string; real: string; dev: number; ino: number; }
export class FolderGuard {
  private readonly real: string;
  private readonly dev: number;
  private readonly ino: number;
  readonly path: string;
  constructor(path: string, grant?: FolderGrant) {
    this.path = path;
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The phone inbox folder must be a real directory.");
    this.real = realpathSync(path);
    this.dev = stat.dev; this.ino = stat.ino;
    if (grant && this.real !== grant.real && (stat.dev !== grant.dev || stat.ino !== grant.ino))
      throw new Error("The granted phone folder changed. Choose it again.");
  }
  grant(): FolderGrant { return { path: this.path, real: this.real, dev: this.dev, ino: this.ino }; }
  check() {
    const stat = lstatSync(this.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || realpathSync(this.path) !== this.real && (stat.dev !== this.dev || stat.ino !== this.ino))
      throw new Error("The phone inbox folder moved or became a link. Choose the folder again.");
  }
}
export class PhoneFolder {
  private guards = new Map<string, FolderGuard>();
  private watchers: FSWatcher[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;
  private stopped = false;
  private warned = new Set<string>();
  private publications = new Map<string, { snapshot?: PhoneSnapshot; done: Promise<void> }>();
  readonly root: FolderGuard;
  private readonly devices: PhoneDevices;
  private readonly store: PhoneInboxStore;
  private readonly changed: () => void;
  private readonly onError: (message: string) => void;
  constructor(path: string, devices: PhoneDevices, store: PhoneInboxStore,
      changed: () => void, onError: (message: string) => void, grant?: FolderGrant) {
    this.devices = devices; this.store = store; this.changed = changed; this.onError = onError;
    this.root = new FolderGuard(path, grant);
  }
  private async directory(path: string, create = false) {
    this.root.check();
    if (create) {
      try { lstatSync(path); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        await mkdir(path);
      }
    }
    let guard = this.guards.get(path);
    if (!guard) { guard = new FolderGuard(path); this.guards.set(path, guard); }
    guard.check();
    return guard;
  }
  publish(scriptId: string, snapshot: PhoneSnapshot): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const queued = this.publications.get(scriptId);
    if (queued) { queued.snapshot = snapshot; return queued.done; }
    const publication = { snapshot: snapshot as PhoneSnapshot | undefined, done: Promise.resolve() };
    this.publications.set(scriptId, publication);
    publication.done = (async () => {
      try {
        while (publication.snapshot) {
          const latest = publication.snapshot;
          publication.snapshot = undefined;
          try { await this.writeSnapshot(scriptId, latest); }
          catch (e) { if (!publication.snapshot) throw e; }
        }
      } finally { this.publications.delete(scriptId); }
    })();
    return publication.done;
  }
  private async writeSnapshot(scriptId: string, snapshot: PhoneSnapshot) {
    const envelope = JSON.stringify({ v: 2, scriptId, ...snapshot });
    if (Buffer.byteLength(envelope, "utf8") > 2_000_000)
      throw new Error("Production snapshot exceeds 2,000,000 bytes.");
    const inbox = await this.directory(join(this.root.path, INBOX_FOLDER), true);
    for (const device of this.devices.all().filter(d => !d.revoked && d.scriptId === scriptId)) {
      if (!receiptId.test(device.id)) continue;
      const directory = await this.directory(join(inbox.path, device.id), true);
      this.root.check(); inbox.check(); directory.check();
      const path = join(directory.path, `.production-${crypto.randomUUID()}.tmp`);
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(envelope);
        await file.sync();
        this.root.check(); inbox.check(); directory.check();
        await rename(path, join(directory.path, "production.json"));
      } finally { await file.close(); await unlink(path).catch(() => {}); }
    }
  }
  async start() {
    const inbox = await this.directory(join(this.root.path, INBOX_FOLDER), true);
    for (const path of [this.root.path, inbox.path]) {
      try {
        const watcher = watch(path, { recursive: path === inbox.path }, () => { void this.scan(); });
        watcher.on("error", error => this.onError(`Folder notifications unavailable; rescanning every five seconds. ${error.message}`));
        this.watchers.push(watcher);
      } catch { /* Rescans also cover delayed cloud delivery. */ }
    }
    this.timer = setInterval(() => { void this.scan(); }, 5000);
    this.timer.unref();
    await this.scan();
  }
  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.scanning) return this.scanning;
    this.scanning = this.read().catch(e => this.onError(String(e))).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  private async read() {
    this.root.check();
    const inbox = await this.directory(join(this.root.path, INBOX_FOLDER));
    for (const device of this.devices.all().filter(d => !d.revoked)) {
      if (!receiptId.test(device.id) || !receiptId.test(device.scriptId)) continue;
      let folder: FolderGuard;
      try { inbox.check(); folder = await this.directory(join(inbox.path, device.id)); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        this.onError(String(e)); continue;
      }
      this.root.check(); inbox.check(); folder.check();
      for (const name of await readdir(folder.path)) {
        if (!name.endsWith(".json") || !receiptId.test(name.slice(0, -5))) continue;
        try {
          this.root.check(); inbox.check(); folder.check();
          const path = join(folder.path, name), file = await openForRead(path);
          if (!file) continue;
          let item: PhoneInbox;
          try {
            if (file.info.size > 26000) throw new Error("Phone inbox file exceeds 26,000 bytes.");
            const bytes = await file.read(26000);
            if (bytes.length > 26000) throw new Error("Phone inbox file exceeds 26,000 bytes.");
            item = validateFolderItem(JSON.parse(new TextDecoder().decode(bytes)), device.id, device.scriptId,
              this.devices.verifyTake.bind(this.devices));
            if (item.id + ".json" !== name) throw new Error("Phone receipt does not match its file name.");
          } finally { await file.close(); }
          this.root.check(); inbox.check(); folder.check();
          await this.devices.receive(device.id, device.scriptId, item, this.store);
          this.root.check(); inbox.check(); folder.check();
          await unlink(path);
          this.warned.delete(path);
          this.changed();
        } catch (e) {
          const path = join(folder.path, name);
          if (!this.warned.has(path)) { this.warned.add(path); this.onError(`${name}: ${String(e)}`); }
        }
      }
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.watchers.forEach(w => w.close());
    await this.scanning;
    await Promise.allSettled([...this.publications.values()].map(p => p.done));
  }
}
