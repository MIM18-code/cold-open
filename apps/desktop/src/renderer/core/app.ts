// The renderer's app object: the open document, the editor bridge, UI state (view, panels, modals, toasts)
// and the feature registry. Features are folders under src/renderer/features with an index.tsx whose default
// export is a Feature; they are discovered automatically, so adding one touches no shared file.
import type { ComponentType } from "react";

import { matchesKey } from "../../shared/accelerator.ts";
import { observeNavigation } from "./location-history.ts";
import { resolveCommands } from "./shortcuts.ts";
import { CHANNELS, type MenuCommand, type MenuName } from "../../shared/api.ts";
import type { EditorBridge } from "./editor-bridge.ts";
import { desktop } from "./platform.ts";
import { DocumentSession, ReadOnlyError } from "./session.ts";

export interface Command {
  id: string;
  label: string;
  /** Put the command in this application menu. Commands without a menu still appear in the command palette. */
  menu?: MenuName;
  group?: string;
  /** Electron accelerator syntax: "CmdOrCtrl+Shift+E", "CmdOrCtrl+1", "Alt+Tab". */
  accelerator?: string;
  /** Hide from the command palette. */
  hidden?: boolean;
  run(app: App): unknown;
  enabled?(app: App): boolean;
  checked?(app: App): boolean;
}

export interface PanelDef {
  id: string;
  title: string;
  side: "left" | "right";
  order?: number;
  component: ComponentType;
}

/** A main area view: the script page, index cards, outline. */
export interface ViewDef {
  id: string;
  title: string;
  order?: number;
  component: ComponentType;
}

export interface ModalProps<P = any> {
  close(): void;
  props: P;
}

export interface ModalDef {
  id: string;
  title: string;
  /** Pixel width; "wide" is most of the window. */
  width?: number | "wide";
  component: ComponentType<ModalProps>;
}

export interface StatusItemDef {
  id: string;
  order?: number;
  component: ComponentType;
}

export interface ToolbarItemDef {
  id: string;
  order?: number;
  component: ComponentType;
}

/** A section of the Settings window (Cmd+,). */
export interface SettingsSectionDef {
  id: string;
  title: string;
  order?: number;
  component: ComponentType;
}

export interface Feature {
  id: string;
  commands?: Command[];
  panels?: PanelDef[];
  views?: ViewDef[];
  modals?: ModalDef[];
  status?: StatusItemDef[];
  toolbar?: ToolbarItemDef[];
  settings?: SettingsSectionDef[];
  /** Runs once at startup, after every feature is registered. May return a cleanup function. */
  activate?(app: App): void | (() => void);
}

export interface ActivityEntry { id: number; message: string; at: number; count: number; }
export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error" | "success";
}

export interface UiState {
  view: string;
  leftPanel: string | null;
  rightPanel: string | null;
  modal: { id: string; props: unknown } | null;
  paletteOpen: boolean;
  focusMode?: boolean;
  toasts: Toast[];
}

type Listener = () => void;

export class App {
  session: DocumentSession;
  editor: EditorBridge | null = null;
  ui: UiState = { view: "script", leftPanel: "navigator", rightPanel: null, modal: null, paletteOpen: false, toasts: [] };
  settings: Record<string, unknown> = {};
  readonly features: Feature[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly sessionListeners = new Set<(session: DocumentSession, previous: DocumentSession) => void>();
  private readonly flushers = new Set<() => void>();
  private toastId = 0;
  activity: ActivityEntry[] = [];
  clearActivity(): void { this.activity = []; this.emit(); }
  private releaseNavigation: (() => void) | undefined;
  private menuTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.session = DocumentSession.untitled();
  }

  register(feature: Feature): void {
    this.features.push(feature);
  }

  get commands(): Command[] {
    return resolveCommands(this.features.flatMap((feature) => feature.commands ?? []), this.settings["keyboard.bindings"]);
  }
  get panels(): PanelDef[] {
    return this.features.flatMap((feature) => feature.panels ?? []).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  }
  get views(): ViewDef[] {
    return this.features.flatMap((feature) => feature.views ?? []).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  }
  get modals(): ModalDef[] {
    return this.features.flatMap((feature) => feature.modals ?? []);
  }
  get statusItems(): StatusItemDef[] {
    return this.features.flatMap((feature) => feature.status ?? []).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  }
  get settingsSections(): SettingsSectionDef[] {
    return this.features.flatMap((feature) => feature.settings ?? []).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  }
  get toolbarItems(): ToolbarItemDef[] {
    return this.features.flatMap((feature) => feature.toolbar ?? []).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  }

  /**
   * Write edits that are still held outside the document (a section title being typed, a synopsis waiting for
   * its pause) into it now. Save, Export, closing the window and swapping the document call this first, so
   * what they read is what the writer sees.
   */
  flushPending(): void {
    for (const flush of [...this.flushers]) {
      try {
        flush();
      } catch (error) {
        console.error("Writing a pending edit failed", error);
      }
    }
  }

  /** Register a flush for flushPending. Returns a function that removes it. */
  onFlush(flush: () => void): () => void {
    this.flushers.add(flush);
    return () => this.flushers.delete(flush);
  }

  /** Swap the open document (File > Open into this window, New). The old session is destroyed. */
  setSession(session: DocumentSession): void {
    if (session === this.session) return;
    this.flushPending();
    const previous = this.session;
    this.session = session;
    for (const listener of this.sessionListeners) listener(session, previous);
    previous.destroy();
    this.emit();
  }

  onSession(listener: (session: DocumentSession, previous: DocumentSession) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  setEditor(editor: EditorBridge | null): void {
    this.releaseNavigation?.();
    this.editor = editor;
    this.releaseNavigation = editor ? observeNavigation(() => this.session, editor) : undefined;
    this.emit();
  }

  async runCommand(id: string): Promise<void> {
    const command = this.commands.find((c) => c.id === id);
    if (!command || (command.enabled && !command.enabled(this))) return;
    try {
      await command.run(this);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), "error");
    }
    this.refreshMenu();
  }

  setFocusMode(enabled: boolean): void {
    this.ui = { ...this.ui, focusMode: enabled };
    this.emit();
    this.refreshMenu();
  }

  setView(view: string): void {
    this.ui = { ...this.ui, view };
    this.emit();
    this.refreshMenu();
  }

  /** Show a side panel, or hide it when it is already showing (toggle). */
  togglePanel(id: string, show?: boolean): void {
    const panel = this.panels.find((p) => p.id === id);
    if (!panel) return;
    const key = panel.side === "left" ? "leftPanel" : "rightPanel";
    const visible = this.ui[key] === id;
    this.ui = { ...this.ui, [key]: (show ?? !visible) ? id : null };
    this.emit();
    this.refreshMenu();
  }

  openModal(id: string, props?: unknown): void {
    this.ui = { ...this.ui, modal: { id, props } };
    this.emit();
    this.refreshMenu();
  }

  closeModal(): void {
    this.ui = { ...this.ui, modal: null };
    this.emit();
    this.editor?.focus();
    this.refreshMenu();
  }

  setPalette(open: boolean): void {
    this.ui = { ...this.ui, paletteOpen: open };
    this.emit();
  }

  toast(message: string, kind: Toast["kind"] = "info"): void {
    const toast = { id: ++this.toastId, message, kind };
    if (kind === "error") {
      const previous = this.activity.find(e => e.message === message);
      this.activity = [{ id: previous?.id ?? toast.id, message, at: Date.now(), count: (previous?.count ?? 0) + 1 }, ...this.activity.filter(e => e !== previous)].slice(0, 50);
    }
    this.ui = { ...this.ui, toasts: [...this.ui.toasts, toast] };
    this.emit();
    setTimeout(() => {
      this.ui = { ...this.ui, toasts: this.ui.toasts.filter((t) => t.id !== toast.id) };
      this.emit();
    }, kind === "error" ? 8000 : 4000);
  }

  setting<T>(key: string, fallback: T): T {
    return (this.settings[key] as T | undefined) ?? fallback;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    const previous = this.settings;
    this.settings = { ...this.settings, [key]: value };
    this.emit();
    try {
      await desktop.invoke(CHANNELS.settingsSet, key, value);
    } catch (error) {
      // The main process refused (a key it owns, such as files.* or grants.*): keep this window's copy truthful.
      if (this.settings[key] === value) this.settings = { ...this.settings, [key]: previous[key] };
      this.emit();
      throw error;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Bumped on every emit, so hooks can cache derived values per state. */
  revision = 0;

  emit(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  /** Send the menu commands to the main process, debounced. Call after state that affects enabled/checked changes. */
  refreshMenu(): void {
    clearTimeout(this.menuTimer);
    this.menuTimer = setTimeout(() => {
      const items: MenuCommand[] = this.commands.filter((c) => c.menu).map((c) => ({
        id: c.id, label: c.label, menu: c.menu!,
        ...(c.group ? { group: c.group } : {}),
        ...(c.accelerator ? { accelerator: c.accelerator } : {}),
        enabled: c.enabled ? c.enabled(this) : true,
        ...(c.checked ? { checked: c.checked(this) } : {}),
      }));
      void desktop.invoke(CHANNELS.setMenu, items);
    }, 50);
  }

  async start(): Promise<void> {
    this.settings = await desktop.invoke<Record<string, unknown>>(CHANNELS.settingsGet);
    desktop.on(CHANNELS.settingsChanged, (key, value) => {
      this.settings = { ...this.settings, [key as string]: value };
      this.emit();
      if (key === "keyboard.bindings") this.refreshMenu();
    });
    desktop.on(CHANNELS.runCommand, (id) => void this.runCommand(id as string));
    window.addEventListener("keydown", (event) => this.handleKey(event));
    window.addEventListener("focusin", () => this.refreshMenu());
    window.addEventListener("focusout", () => this.refreshMenu());
    // A read-only script refuses edits from any button (a dialog's Apply, a panel's Accept), not only commands;
    // say why nothing happened instead of failing silently.
    const refused = (error: unknown, event: Event) => {
      if (!(error instanceof ReadOnlyError)) return;
      event.preventDefault();
      this.toast(error.message, "error");
    };
    window.addEventListener("error", (event) => refused(event.error, event));
    window.addEventListener("unhandledrejection", (event) => refused(event.reason, event));
    for (const feature of this.features) {
      try {
        feature.activate?.(this);
      } catch (error) {
        console.error(`Feature ${feature.id} failed to start`, error);
      }
    }
    this.refreshMenu();
  }

  /**
   * Accelerators for keys that reach the page. In the app, a real key press for a menu command is taken by the
   * main process before the page or the menu sees it (before-input-event in src/main/index.ts) and arrives as
   * one runCommand, so what gets here is palette-only commands, everything in a browser, and synthetic input.
   * Handling it here cancels the key, which keeps the native menu from running it a second time.
   */
  private handleKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || this.ui.modal || this.ui.paletteOpen) return;
    if (event.key === "Escape" && this.ui.focusMode) {
      event.preventDefault(); this.setFocusMode(false); return;
    }
    for (const command of this.commands) {
      if (!command.accelerator || (command.enabled && !command.enabled(this))) continue;
      if (matchesAccelerator(event, command.accelerator)) {
        event.preventDefault();
        void this.runCommand(command.id);
        return;
      }
    }
  }
}

export function matchesAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  return matchesKey({ key: event.key, code: event.code, meta: event.metaKey, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, composing: event.isComposing },
    accelerator, navigator.platform.startsWith("Mac"));
}

export const app = new App();
