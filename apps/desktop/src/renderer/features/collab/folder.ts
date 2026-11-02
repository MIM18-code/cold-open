// The renderer side of folder sync: start it for a saved .screenplay document when the writer turned it on (or a
// sync folder already sits next to the file), send local changes to the main process, and apply other devices'
// changes with their own origin so undo skips them.
import * as Y from "yjs";

import { SYNC, type FolderStartResult } from "../../../shared/channels/sync.ts";
import type { App } from "../../core/app.ts";
import { desktop, isDesktop } from "../../core/platform.ts";
import type { DocumentSession } from "../../core/session.ts";

export const FOLDER_ORIGIN = Symbol("folder-sync");

export interface FolderState {
  active: boolean;
  /** The sidecar folder, while active. */
  folder: string | null;
  error: string | null;
}

export class FolderSyncClient {
  state: FolderState = { active: false, folder: null, error: null };
  private readonly app: App;
  private readonly onChange: () => void;
  private session: DocumentSession | null = null;
  private path: string | null = null;
  /** The main process's ID for the running sync; appends and the stop name it. */
  private subscription: string | null = null;
  /** Bumped by stop(). A start begun in an earlier generation is stale: it ends its own subscription and nothing else. */
  private generation = 0;
  private stopSession: (() => void)[] = [];
  private watching: { session: DocumentSession; off: () => void; checked: string | null } | null = null;

  constructor(app: App, onChange: () => void) {
    this.app = app;
    this.onChange = onChange;
    if (!isDesktop) return;
    desktop.on(SYNC.folderUpdates, (path, updates) => {
      if (path !== this.path || !this.session || !Array.isArray(updates) || !updates.length) return;
      this.session.doc.applyUpdate(updates.length === 1 ? updates[0] as Uint8Array : Y.mergeUpdates(updates as Uint8Array[]), FOLDER_ORIGIN);
    });
    desktop.on(SYNC.folderError, (path, message) => {
      if (path !== this.path) return;
      this.set({ error: String(message) });
    });
  }

  /** Folder sync needs a document saved in the app's own format: only it keeps the shared Yjs history. */
  eligible(session: DocumentSession): boolean {
    return isDesktop && !!session.path && session.format === "screenplay";
  }

  /** Follow the window's document: stop for the old one, and start for the new one when it is set to sync. */
  watch(session: DocumentSession): void {
    this.watching?.off();
    void this.stop();
    const watching = { session, off: () => undefined as void, checked: null as string | null };
    // Save As gives an untitled script a path, or moves it; check again whenever the path changes.
    const check = () => {
      if (watching.checked === session.path) return;
      watching.checked = session.path;
      if (this.path && this.path !== session.path) void this.stop();
      void this.autoStart(session);
    };
    watching.off = session.onState(check);
    this.watching = watching;
    check();
  }

  async toggle(session: DocumentSession): Promise<void> {
    if (this.state.active) {
      const path = this.path!;
      await this.stop();
      await desktop.invoke(SYNC.folderSet, path, false);
      this.app.toast("Folder sync is off for this script.");
      return;
    }
    if (!this.eligible(session)) throw new Error("Save the script as a .screenplay file first. Folder sync works only with the app's own format.");
    await desktop.invoke(SYNC.folderSet, session.path, true);
    await this.start(session);
    this.app.toast(`Syncing through ${this.state.folder?.split("/").pop() ?? "the sync folder"}. Keep it in iCloud Drive or Dropbox next to the script.`, "success");
  }

  /** Re-send the complete local state; later incremental updates alone cannot repair a missing append. */
  async retry(session: DocumentSession): Promise<void> {
    if (!this.eligible(session) || session !== this.app.session) return;
    await this.stop();
    if (session === this.app.session) await this.start(session);
  }

  async stop(): Promise<void> {
    const path = this.path;
    const subscription = this.subscription;
    this.generation++;
    for (const off of this.stopSession.splice(0)) off();
    this.session = null;
    this.path = null;
    this.subscription = null;
    // Before the await: a start for the next document may finish first, and must not be shown as off.
    this.set({ active: false, folder: null, error: null });
    if (path && subscription) await desktop.invoke(SYNC.folderStop, path, subscription).catch(() => undefined);
  }

  private async autoStart(session: DocumentSession): Promise<void> {
    if (!this.eligible(session) || this.path === session.path) return;
    const generation = this.generation;
    try {
      if (await desktop.invoke<boolean>(SYNC.folderEnabled, session.path)) await this.start(session, generation);
    } catch (error) {
      if (generation === this.generation) this.set({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async start(session: DocumentSession, generation = this.generation): Promise<void> {
    const path = session.path!;
    if (generation !== this.generation || this.path === path) return;
    if (this.path) {
      await this.stop();
      generation = this.generation;
    }
    // Changes made while the main process starts must reach the log too: every later change from this window
    // builds on them, and the other devices would hold all of it back until they arrived.
    const early: Uint8Array[] = [];
    const collect = (update: Uint8Array, origin: unknown) => void (origin !== FOLDER_ORIGIN && early.push(update));
    session.doc.ydoc.on("update", collect);
    let result: FolderStartResult;
    try {
      result = await desktop.invoke<FolderStartResult>(SYNC.folderStart, path, session.doc.encodeState());
    } finally {
      session.doc.ydoc.off("update", collect);
    }
    // Revert or Open replaced the document meanwhile (perhaps with one at the same path, which the main process
    // tells apart only by subscription), or another start got there first: end this start's subscription alone.
    if (generation !== this.generation || this.app.session !== session || session.path !== path || this.path) {
      await desktop.invoke(SYNC.folderStop, path, result.subscription).catch(() => undefined);
      return;
    }
    const subscription = result.subscription;
    this.session = session;
    this.path = path;
    this.subscription = subscription;
    const send = (update: Uint8Array) => void desktop.invoke(SYNC.folderAppend, path, subscription, update).catch((error) => {
      // A late failure belongs to its old subscription, not a newly opened script.
      if (this.session !== session || this.subscription !== subscription) return;
      const message = `Local sync log did not accept an edit: ${error instanceof Error ? error.message : String(error)}. Save this draft and retry folder sync.`;
      if (!this.state.error) this.app.toast(message, "error");
      this.set({ error: message });
    });
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin !== FOLDER_ORIGIN) send(update);
    };
    session.doc.ydoc.on("update", onUpdate);
    this.stopSession.push(() => session.doc.ydoc.off("update", onUpdate));
    if (early.length) send(Y.mergeUpdates(early));
    if (result.updates.length) session.doc.applyUpdate(Y.mergeUpdates(result.updates), FOLDER_ORIGIN);
    this.set({ active: true, folder: result.folder, error: null });
  }

  private set(change: Partial<FolderState>): void {
    this.state = { ...this.state, ...change };
    this.onChange();
  }
}
