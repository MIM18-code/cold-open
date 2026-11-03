// The main process: one window per document, an application menu built from the commands the focused
// window registers, and the services in src/main/services.
import {
  app, BrowserWindow, dialog, Menu, nativeTheme, shell, screen,
  type MenuItemConstructorOptions, type WebContents, type WebFrameMain,
} from "electron";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseInvite } from "@screenplay/relay/protocol";
import { SYNC, type JoinHandoff } from "../shared/channels/sync.ts";
import { isTemplateId } from "@screenplay/engine";

import { matchesKey } from "../shared/accelerator.ts";
import { CHANNELS, MENUS, type MenuCommand } from "../shared/api.ts";
import { createContext } from "./context.ts";
import { isScreenplayFile, SCREENPLAY_EXTENSIONS } from "./recent-files.ts";
import { attachDocumentTab, performTabAction } from "./native-tabs.ts";
import { registerSystemAccent } from "./system-accent.ts";
import { registerServices } from "./services/index.ts";
import { openTakesFile } from "./services/phone.ts";
import { isTakesFileName } from "./phone/takes.ts";
import { isLink } from "./safe-fs.ts";
import { legacyUserDataPath } from "./user-data.ts";
import { windowBackground } from "./window-theme.ts";
import { WINDOW_MEMORY_KEY, WorkspaceMemory, windowMemories, visibleBounds, type WindowMemory } from "./workspace/memory.ts";

app.setName("Cold Open");
useLegacyUserData();
// One running copy per profile. A second launch (`open -n`, or a double-click while the app is starting) hands its
// files to the first and exits, so two processes never renew the same ChatGPT sign-in or write the same settings.
// A separate --user-data-dir, as the tests use, gets its own lock and still runs side by side.
if (!app.requestSingleInstanceLock()) process.exit(0);
// End-to-end tests run hidden: no Dock icon, and no native dialog may attach to (and show) a hidden window.
const e2e = !!process.env.SCREENPLAY_E2E;
const devUrl = process.env.SCREENPLAY_DEV_URL;
const rendererIndex = join(import.meta.dirname, "../renderer/index.html");
const commands = new Map<number, MenuCommand[]>();
const closable = new Set<number>();
// A close request is out to these windows; another close (a second Cmd+Q) must not ask again.
const closing = new Set<number>();
// Windows whose renderer has subscribed to messages, and paths waiting for one that has not yet.
const ready = new Set<number>();
const queuedOpen = new Map<number, string[]>();
// Quit asks each window in turn (unsaved changes); after a window agrees and closes, quitting continues.
let quitRequested = false;
const joins = new WeakMap<WebContents, JoinHandoff>();
let launchInvite: JoinHandoff | undefined;
let pendingOpen: string[] = process.argv.slice(app.isPackaged ? 1 : 2).filter(isDocumentPath).map((path) => resolve(path));
let pendingTakes: string[] = process.argv.slice(app.isPackaged ? 1 : 2).filter(isTakesPath).map((path) => resolve(path));

function isDocumentPath(path: string): boolean {
  return /\.(screenplay|fdx|fountain|spmd|txt)$/i.test(path) && !path.startsWith("-");
}

/** A batch of takes shared by AirDrop, not a screenplay to open in a window. */
function isTakesPath(path: string): boolean {
  return isTakesFileName(path) && !basename(path).startsWith("-");
}

/** Import an AirDropped takes file into the inbox of the script a window already has open. */
function openTakes(path: string): void {
  void openTakesFile(path).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (e2e) {
      console.error(`Could not add takes from ${path}: ${message}`);
      return;
    }
    void dialog.showMessageBox({ type: "warning", message: "These takes were not added.", detail: message, buttons: ["OK"] });
  });
}

/** Only the main frame of one of our windows, showing our own page, may call services. */
function isTrusted(sender: WebContents, frame: WebFrameMain | null): boolean {
  if (!frame || frame !== sender.mainFrame || !BrowserWindow.fromWebContents(sender)) return false;
  let url: URL;
  try {
    url = new URL(frame.url);
  } catch {
    return false;
  }
  if (devUrl) return url.origin === new URL(devUrl).origin;
  return url.protocol === "file:" && url.pathname === pathToFileURL(rendererIndex).pathname;
}

const ctx = createContext(isTrusted);
const previousWindows = windowMemories(ctx.settings.get(WINDOW_MEMORY_KEY));
const windowPaths = new Map<number, string>();
const workspaceMemory = new WorkspaceMemory((rows) => {
  if (JSON.stringify(ctx.settings.get(WINDOW_MEMORY_KEY)) !== JSON.stringify(rows)) ctx.settings.set(WINDOW_MEMORY_KEY, rows);
});
function rememberWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const id = window.webContents.id, path = windowPaths.get(id);
  workspaceMemory.update(id, path && ctx.isAllowedPath(path) && isScreenplayFile(path) ? { path, bounds: window.getNormalBounds() } : null);
}

type WindowMode = "open" | "recover";

function createWindow(path?: string, mode: WindowMode = "open", tabParent?: BrowserWindow, restoredBounds?: WindowMemory["bounds"], template?: string): BrowserWindow {
  const focused = BrowserWindow.getFocusedWindow();
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    show: false,
    titleBarStyle: "hiddenInset",
    ...(process.platform === "darwin" ? { tabbingIdentifier: "screenplay-documents" } : {}),
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: windowBackground(ctx.settings.get("appearance.theme"), nativeTheme.shouldUseDarkColors),
    ...(focused ? { x: focused.getBounds().x + 28, y: focused.getBounds().y + 28 } : {}),
    ...(restoredBounds ? visibleBounds(restoredBounds, screen.getDisplayMatching(restoredBounds).workArea) : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  const id = window.webContents.id;
  if (mode === "open" && path && ctx.isAllowedPath(path)) windowPaths.set(id, path);
  rememberWindow(window);
  let positionTimer: ReturnType<typeof setTimeout> | undefined;
  const rememberPosition = () => { clearTimeout(positionTimer); positionTimer = setTimeout(() => rememberWindow(window), 300); };
  window.on("move", rememberPosition); window.on("resize", rememberPosition);
  window.on("closed", () => { clearTimeout(positionTimer); windowPaths.delete(id); workspaceMemory.close(id); });
  const query: Record<string, string> = {
    ...(path ? { [mode]: path } : {}),
    ...(template ? { template } : {}),
  };
  const withQuery = Object.keys(query).length > 0;
  if (devUrl) void window.loadURL(devUrl + (withQuery ? `?${new URLSearchParams(query)}` : ""));
  else void window.loadFile(rendererIndex, withQuery ? { query } : {});
  // End-to-end tests run hidden so they don't take over the screen.
  window.once("ready-to-show", () => {
    // Attaching hidden NSWindows may make them visible. Tests verify the adapter separately.
    if (!e2e) {
      attachDocumentTab(process.platform, tabParent, window);
      window.show();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on("did-start-loading", () => ready.delete(id));
  // One key press runs one command. A menu command's key could otherwise reach both the page (the editor runs
  // its own shortcuts, and Chromium turns Cmd+B in editable text into its own bold) and the menu. Electron emits
  // before-input-event ahead of the page's keydown and the menu's key equivalents, and preventDefault here stops
  // both, so the command is sent from here once. Keys that never pass through here (CDP input in tests) reach
  // the page, which runs the command and cancels the key, so the menu does not run it either.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || (!input.meta && !input.control)) return;
    const press = { key: input.key, code: input.code, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift, composing: input.isComposing };
    const command = commands.get(id)?.find((c) => c.accelerator && c.enabled !== false && matchesKey(press, c.accelerator, process.platform === "darwin"));
    if (!command) return;
    event.preventDefault();
    ctx.send(window, CHANNELS.runCommand, command.id);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer for window ${id} exited: ${details.reason} (${details.exitCode})`);
    if (details.reason !== "clean-exit" && !window.isDestroyed()) {
      void dialog.showMessageBox(window, { type: "error", message: "This window stopped working.", detail: "Your last autosave is kept and offered when you reopen the app.", buttons: ["Reload"] })
        .then(() => !window.isDestroyed() && window.reload());
    }
  });
  window.webContents.on("did-fail-load", (_event, code, description, url) => console.error(`Window ${id} failed to load ${url}: ${description} (${code})`));
  window.on("close", (event) => {
    if (closable.has(id)) return;
    event.preventDefault();
    // Not loaded yet: nothing to save, so close straight away.
    if (!ready.has(id)) {
      closable.add(id);
      setImmediate(() => window.close());
      return;
    }
    if (closing.has(id)) return;
    closing.add(id);
    ctx.send(window, CHANNELS.closeRequested);
  });
  window.on("closed", () => {
    commands.delete(id);
    closable.delete(id);
    closing.delete(id);
    ready.delete(id);
    queuedOpen.delete(id);
    rebuildMenu();
    if (quitRequested) setImmediate(() => app.quit());
  });
  window.on("focus", rebuildMenu);
  return window;
}

function openInBestWindow(path: string): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!target) {
    createWindow(path);
    return;
  }
  // The renderer decides whether to load into this window (untitled and unchanged) or ask for a new one.
  const id = target.webContents.id;
  if (ready.has(id)) ctx.send(target, CHANNELS.openPath, path);
  else queuedOpen.set(id, [...(queuedOpen.get(id) ?? []), path]);
}

async function openWithoutWindow(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: "Open",
    properties: ["openFile"],
    filters: [{ name: "Screenplays", extensions: [...SCREENPLAY_EXTENSIONS] }],
  });
  for (const path of result.filePaths) {
    ctx.allowPath(path);
    createWindow(path);
  }
}

function rebuildMenu(): void {
  const focused = BrowserWindow.getFocusedWindow();
  const list = (focused && commands.get(focused.webContents.id)) || [];
  const run = (command: MenuCommand) => () => {
    const window = BrowserWindow.getFocusedWindow();
    if (window) ctx.send(window, CHANNELS.runCommand, command.id);
  };
  const itemsFor = (menu: string): MenuItemConstructorOptions[] => {
    const items: MenuItemConstructorOptions[] = [];
    let group: string | undefined;
    for (const command of list.filter((c) => c.menu === menu)) {
      if (items.length && command.group !== group) items.push({ type: "separator" });
      group = command.group;
      items.push({
        label: command.label,
        click: run(command),
        enabled: command.enabled ?? true,
        ...(command.accelerator ? { accelerator: command.accelerator } : {}),
        ...(command.checked !== undefined ? { type: "checkbox" as const, checked: command.checked } : {}),
      });
    }
    return items;
  };
  const template: MenuItemConstructorOptions[] = [{ role: "appMenu" }];
  for (const menu of MENUS) {
    let items = itemsFor(menu);
    if (menu === "File") {
      // With no window focused (all closed on macOS), New and Open still work from the main process.
      const own: MenuItemConstructorOptions[] = list.length ? [] : [
        { label: "New", accelerator: "CmdOrCtrl+N", click: () => createWindow() },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void openWithoutWindow() },
      ];
      items = [...own, { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() }, { type: "separator" }, ...items,
        { type: "separator" }, { role: "close" }];
    }
    if (menu === "Edit") {
      // Undo and Redo come from the editor (they act on the shared document); clipboard items stay native.
      items = [...items, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" },
        { role: "selectAll" }];
    }
    if (menu === "View") items = [...items, { type: "separator" }, { role: "togglefullscreen" }, { role: "toggleDevTools" }];
    if (items.length) template.push({ label: menu, submenu: items });
  }
  template.push(process.platform === "darwin" ? {
    label: "Window", submenu: [
      { role: "minimize" }, { role: "zoom" }, { type: "separator" },
      { label: "Show / Hide Tab Bar", click: () => performTabAction(process.platform, BrowserWindow.getFocusedWindow(), "toggle") },
      { label: "Merge All Windows into Tabs", click: () => performTabAction(process.platform, BrowserWindow.getFocusedWindow(), "merge") },
      { label: "Move Tab to New Window", click: () => performTabAction(process.platform, BrowserWindow.getFocusedWindow(), "detach") },
      { type: "separator" }, { role: "front" }, { role: "window" },
    ],
  } : { role: "windowMenu" });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ctx.handle("shell:renderer-ready", (event) => {
  const id = event.sender.id;
  ready.add(id);
  const window = ctx.windowOf(event.sender);
  for (const path of queuedOpen.get(id) ?? []) if (window) ctx.send(window, CHANNELS.openPath, path);
  queuedOpen.delete(id);
});
ctx.handle(CHANNELS.setMenu, (event, list: MenuCommand[]) => {
  commands.set(event.sender.id, list);
  if (BrowserWindow.fromWebContents(event.sender) === BrowserWindow.getFocusedWindow()) rebuildMenu();
});
ctx.handle(CHANNELS.setWindowState, (event, state: { title: string; edited: boolean; path?: string }) => {
  const window = ctx.windowOf(event.sender);
  if (!window) return;
  window.setTitle(state.title);
  window.setDocumentEdited(state.edited);
  const path = state.path && ctx.isAllowedPath(state.path) && isScreenplayFile(state.path) ? state.path : "";
  window.setRepresentedFilename(path);
  if (path) windowPaths.set(event.sender.id, path); else windowPaths.delete(event.sender.id);
  rememberWindow(window);
});
ctx.handle(CHANNELS.closeAllowed, (event) => {
  const window = ctx.windowOf(event.sender);
  if (!window) return;
  closing.delete(event.sender.id);
  closable.add(event.sender.id);
  window.close();
});
ctx.handle("shell:close-cancelled", (event) => {
  closing.delete(event.sender.id);
  quitRequested = false;
  workspaceMemory.cancelQuit();
});
// A window may hand another window only a file it can already reach. A file it may only read (a project search
// result) becomes writable only after the writer confirms in a dialog this process shows, so a page cannot turn
// a search into write access by asking for a window.
ctx.handle(CHANNELS.newWindow, async (event, path?: string, mode: WindowMode = "open", template?: unknown) => {
  if (path !== undefined && (typeof path !== "string" || !ctx.isReadablePath(path))) {
    throw new Error("That file was not opened through the app.");
  }
  if (template !== undefined && !isTemplateId(template)) throw new Error("Unknown document template.");
  if (path !== undefined && !ctx.isAllowedPath(path)) {
    if (!(await confirmOpenForEditing(ctx.windowOf(event.sender), path))) return;
    // The file may have been swapped for a link while the dialog was open; the read grant is pinned to where the
    // path led when it was chosen, so recheck it before upgrading.
    if (!ctx.isReadablePath(path)) throw new Error("That file changed while you were deciding. Search for it again.");
    ctx.allowPath(path);
  }
  createWindow(path, mode === "recover" ? "recover" : "open", undefined, undefined, template);
});
async function confirmOpenForEditing(window: BrowserWindow | null, path: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: "question", message: `Open “${basename(path)}” for editing?`, detail: path,
    buttons: ["Open", "Cancel"], defaultId: 0, cancelId: 1,
  };
  if (e2e && (!window || !window.isVisible())) {
    const scripted = (globalThis as { e2eMessageBox?: (options: Electron.MessageBoxOptions) => number }).e2eMessageBox;
    return (scripted ? scripted(options) : 1) === 0;
  }
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}
ctx.handle(CHANNELS.newTab, (event, path?: string) => {
  if (path !== undefined && (typeof path !== "string" || !ctx.isAllowedPath(path))) throw new Error("That file was not opened through the app.");
  createWindow(path, "open", ctx.windowOf(event.sender) ?? undefined);
});
ctx.handle(CHANNELS.tabAction, (event, action: unknown) => performTabAction(process.platform, ctx.windowOf(event.sender), action));
ctx.handle(CHANNELS.openExternal, (_event, url: string) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
});
ctx.handle("shell:message-box", async (event, options: Electron.MessageBoxOptions) => {
  const window = ctx.windowOf(event.sender);
  if (e2e && (!window || !window.isVisible())) {
    // A test may script the answer; otherwise take "Don't Save" or the cancel button, never a visible sheet.
    const scripted = (globalThis as { e2eMessageBox?: (options: Electron.MessageBoxOptions) => number }).e2eMessageBox;
    const buttons = options.buttons ?? ["OK"];
    const dontSave = buttons.findIndex((label) => /don.t save/i.test(label));
    return { response: scripted ? scripted(options) : dontSave >= 0 ? dontSave : options.cancelId ?? 0, checkboxChecked: false };
  }
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
});

registerServices(ctx);

function openJoinWindow(join: JoinHandoff): void {
  const window = createWindow();
  joins.set(window.webContents, join);
}
ctx.handle(SYNC.newJoinWindow, (_event, invite: string) => {
  parseInvite(invite);
  openJoinWindow({ invite, confirm: false });
});
ctx.handle(SYNC.takeJoin, ({ sender }) => {
  const join = joins.get(sender);
  joins.delete(sender);
  return join ?? null;
});

// Launch Services can deliver the invite before app.ready. Keep the key in memory, out of the window URL.
app.on("open-url", (event, invite) => {
  event.preventDefault();
  if (!/^screenplay:\/\/join\?/i.test(invite) || invite.length > 8192) return;
  const join = { invite, confirm: true };
  if (app.isReady()) openJoinWindow(join);
  else launchInvite = join;
});

app.on("open-file", (event, path) => {
  event.preventDefault();
  if (isTakesPath(path)) {
    if (app.isReady()) openTakes(path);
    else pendingTakes.push(path);
    return;
  }
  ctx.allowPath(path);
  if (app.isReady()) openInBestWindow(path);
  else pendingOpen.push(path);
});

app.on("second-instance", (_event, argv, workingDirectory) => {
  const args = argv.slice(1).filter((arg) => !arg.startsWith("-")).map((arg) => resolve(workingDirectory, arg));
  const documents = args.filter(isDocumentPath), takes = args.filter(isTakesPath);
  for (const path of documents) { ctx.allowPath(path); openInBestWindow(path); }
  for (const path of takes) openTakes(path);
  // Bring the app forward either way: the window that took the file, or the one the writer was last in.
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!window) { if (!documents.length && !takes.length) createWindow(); return; }
  if (window.isMinimized()) window.restore();
  if (!e2e) window.show();
  window.focus();
});

app.whenReady().then(() => {
  registerSystemAccent(ctx);
  if (e2e) app.dock?.hide();
  // A packaged app takes its icon from the bundle; running from source would otherwise show Electron's.
  else if (!app.isPackaged) app.dock?.setIcon(join(import.meta.dirname, "../../build/icon-1024.png"));
  app.setAboutPanelOptions({
    applicationName: "Cold Open",
    applicationVersion: app.getVersion(),
    copyright: "Free and open source.",
  });
  rebuildMenu();
  if (pendingOpen.length) for (const path of pendingOpen) (ctx.allowPath(path), createWindow(path));
  else {
    const restore = ctx.settings.get("workspace.restoreWindows") === true ? previousWindows.filter((row) => isScreenplayFile(row.path) && !isLink(row.path)) : [];
    // Grant only the main-owned, validated saved-file list. Recovery remains a separate explicit prompt.
    for (const row of restore) ctx.allowPath(row.path);
    if (restore.length) for (const row of restore) createWindow(row.path, "open", undefined, row.bounds);
    else if (!launchInvite) createWindow();
  }
  if (launchInvite) openJoinWindow(launchInvite);
  launchInvite = undefined;
  pendingOpen = [];
  // The phone service waits for the restored renderer to register the script before importing takes.
  const takes = [...new Set(pendingTakes)];
  pendingTakes = [];
  for (const path of takes) openTakes(path);
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on("before-quit", () => {
  workspaceMemory.quit();
  quitRequested = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || quitRequested) app.quit();
});

// Keeps an older Screenplay or Inklot settings folder in use; see user-data.ts.
function useLegacyUserData(): void {
  if (app.commandLine.hasSwitch("user-data-dir")) return;
  const folder = legacyUserDataPath(app.getPath("appData"), app.getPath("userData"), (dir) => existsSync(join(dir, "settings.json")));
  if (folder) app.setPath("userData", folder);
}
