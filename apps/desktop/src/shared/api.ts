// The contract between the renderer and the main process. The preload script exposes a DesktopBridge
// as window.desktop. Features add their own channels: a main-process service registers handlers named
// "<feature>:<operation>", and the feature calls them through invoke(). Channel names and payload types
// for a feature live in src/shared/channels/<feature>.ts so both sides import the same types.

export interface DesktopBridge {
  /** Request/response to a handler registered in the main process. Rejects with the handler's error message. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  /** Messages pushed from the main process (menu commands, sync updates, dictation progress). Returns an unsubscribe function. */
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
  /** macOS spell checking through Chromium's native checker. */
  spelling: {
    isMisspelled(word: string): boolean;
    suggestions(word: string): string[];
    addToDictionary(word: string): void;
  };
  platform: string;
}

// Core channels owned by the shell. Feature channels live under src/shared/channels/.

export interface MenuCommand {
  id: string;
  label: string;
  menu: MenuName;
  /** Electron accelerator, for example "CmdOrCtrl+Shift+E". */
  accelerator?: string;
  /** Items in the same group sit together; a separator goes between groups. */
  group?: string;
  enabled?: boolean;
  checked?: boolean;
}

export const MENUS = ["File", "Edit", "Format", "View", "Script", "Production", "Tools"] as const;
export type MenuName = (typeof MENUS)[number];

export interface OpenedFile {
  path: string;
  name: string;
  /** The file's bytes. Text formats are decoded by the renderer. */
  data: Uint8Array;
  /** SHA-256 of the bytes read, for optimistic save-conflict protection. */
  fileHash?: string;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export const CHANNELS = {
  /** renderer → main: replace this window's menu commands. */
  setMenu: "shell:set-menu",
  /** main → renderer: a menu item was chosen. Payload: command id. */
  runCommand: "shell:run-command",
  /** renderer → main: the window title, edited flag and file path for the proxy icon. */
  setWindowState: "shell:set-window-state",
  /** main → renderer: the window wants to close; reply with shell:close-allowed when it may. */
  closeRequested: "shell:close-requested",
  closeAllowed: "shell:close-allowed",
  newWindow: "shell:new-window",
  newTab: "shell:new-tab",
  tabAction: "shell:tab-action",
  /** main → renderer: open this file in this window (Finder double-click, recent menu, launch argument). */
  openPath: "shell:open-path",
  openDialog: "files:open-dialog",
  saveDialog: "files:save-dialog",
  readFile: "files:read",
  writeFile: "files:write",
  recentFiles: "files:recent",
  addRecent: "files:add-recent",
  revealInFinder: "files:reveal",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  /** main → renderer: settings changed in another window. */
  settingsChanged: "settings:changed",
  openExternal: "shell:open-external",
} as const;

/** The app's own document format. */
export const NATIVE_EXTENSION = "screenplay";
