// What every main-process service receives. A service is a module under src/main/services that exports
// register(ctx); src/main/services/index.ts lists them. Services own their IPC channels ("<feature>:<op>").
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from "electron";
import { join, resolve, sep } from "node:path";

import { CHANNELS } from "../shared/api.ts";
import { PathGrants } from "./grants.ts";
import { Settings } from "./settings-store.ts";

export { Settings };

export type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

export interface ServiceContext {
  /** Register an IPC handler. Requests from pages other than the app's own are refused. */
  handle(channel: string, handler: Handler): void;
  /** The window that sent a request. */
  windowOf(sender: WebContents): BrowserWindow | null;
  send(window: BrowserWindow, channel: string, ...args: unknown[]): void;
  broadcast(channel: string, ...args: unknown[]): void;
  settings: Settings;
  /** userData: per-user app data. appRoot: the desktop package root (dev) or app bundle path (packaged). */
  paths: { userData: string; appRoot: string; repoRoot: string };
  /** Run when the app quits, after every window has agreed to close. Async work is awaited, up to a few seconds. */
  onQuit(task: () => unknown): void;
  /**
   * Allow reads and writes of a path the user chose in a dialog or opened. Files outside the allow list (and
   * userData/autosave) cannot be read or written, and neither can a granted path that has since been swapped for a
   * link to somewhere else (grants.ts).
   */
  allowPath(path: string): void;
  isAllowedPath(path: string): boolean;
  /** Search can read chosen files without granting permission to overwrite them. */
  allowReadPath(path: string): void;
  isReadablePath(path: string): boolean;
}

export function createContext(isTrusted: (sender: WebContents, frame: WebFrameMain | null) => boolean): ServiceContext {
  const userData = app.getPath("userData");
  const settings = new Settings(join(userData, "settings.json"));
  const quitTasks: (() => unknown)[] = [];
  const grants = new PathGrants();
  const appRoot = app.isPackaged ? app.getAppPath() : join(import.meta.dirname, "../..");
  const ctx: ServiceContext = {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isTrusted(event.sender, event.senderFrame)) throw new Error("Request from an untrusted page.");
        return handler(event, ...args);
      });
    },
    windowOf: (sender) => BrowserWindow.fromWebContents(sender),
    send(window, channel, ...args) {
      if (!window.isDestroyed()) window.webContents.send(channel, ...args);
    },
    broadcast(channel, ...args) {
      for (const window of BrowserWindow.getAllWindows()) ctx.send(window, channel, ...args);
    },
    settings,
    paths: { userData, appRoot, repoRoot: join(appRoot, "../..") },
    onQuit: (task) => void quitTasks.push(task),
    allowPath: (path) => grants.allow(path),
    allowReadPath: (path) => grants.allow(path, "read"),
    isReadablePath: (path) => {
      if (typeof path !== "string" || !path) return false;
      return grants.allows(path, "read") || resolve(path).startsWith(resolve(userData, "autosave") + sep);
    },
    isAllowedPath: (path) => {
      if (typeof path !== "string" || !path) return false;
      const full = resolve(path);
      // Only the autosave copies in userData: settings, API keys and the dictation helper list there are the
      // main process's own, and a page must not be able to rewrite them.
      return grants.allows(full) || full.startsWith(resolve(userData, "autosave") + sep);
    },
  };
  settings.onChange((key, value) => ctx.broadcast(CHANNELS.settingsChanged, key, value));
  // will-quit fires only once every window has closed, so a cancelled quit never stops a service.
  let quitting = false;
  app.on("will-quit", (event) => {
    if (quitting || !quitTasks.length) return;
    event.preventDefault();
    quitting = true;
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
    void Promise.race([Promise.allSettled(quitTasks.map(async (task) => task())), timeout]).then(() => app.quit());
  });
  return ctx;
}
