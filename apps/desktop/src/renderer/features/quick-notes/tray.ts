// The "Since last time" tray: which unresolved notes arrived after the writer last worked on this script.
// "Last worked on" is per script and local to this Mac, kept in the settings file (notes.since.<hash of the
// script's identity>), never in the document. A session's baseline is read once when the script opens and held in
// memory; the stored time keeps moving while the script is open, so a crash loses at most a minute.
import { useSyncExternalStore } from "react";
import { app } from "../../core/app.ts";
import type { DocumentSession } from "../../core/session.ts";
import { historyId } from "../history/index.tsx";
import { putRecord, records, type ProjectRecord } from "../rewrite/records.ts";
import { captureAnchor } from "./quick-note.ts";
import { nextSeenAt, pruneDismissed, readSeen, trayNotes, type SeenMemory } from "./since.ts";

export const SETTING_PREFIX = "notes.since.";
const HEARTBEAT_MS = 60_000;

export interface TrayState {
  /** The notes to show, newest first. */
  items: ProjectRecord[];
  /** How many of them have not been on screen in the tray yet. */
  unseen: number;
  open: boolean;
}

const EMPTY: TrayState = { items: [], unseen: 0, open: false };
let state: TrayState = EMPTY;
const listeners = new Set<() => void>();
/** Notes this window created through the quick note box. */
const own = new Set<string>();

interface Bound {
  session: DocumentSession;
  key: string | null;
  baseline: number | null;
  /** When this session started. */
  opened: number;
  dismissed: Set<string>;
  shown: Set<string>;
  autoOpened: boolean;
  lastWritten: string;
  off: () => void;
}
let bound: Bound | null = null;

function set(patch: Partial<TrayState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function useTray(): TrayState {
  return useSyncExternalStore((onChange) => (listeners.add(onChange), () => listeners.delete(onChange)), () => state);
}

export function trayState(): TrayState {
  return state;
}

export function rememberOwn(id: string): void {
  own.add(id);
  if (bound) refresh(bound);
}

async function settingKey(session: DocumentSession): Promise<string | null> {
  const identity = historyId(session) ?? (session.path ? `path:${session.path}` : null);
  if (!identity) return null;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return SETTING_PREFIX + [...new Uint8Array(bytes)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function refresh(b: Bound): void {
  if (bound !== b) return;
  const items = trayItemsOf(b);
  if (state.open) for (const item of items) b.shown.add(item.id);
  const unseen = items.filter((item) => !b.shown.has(item.id)).length;
  const same = items.length === state.items.length && items.every((item, i) => item.id === state.items[i]!.id && item.revision === state.items[i]!.revision);
  if (!same || unseen !== state.unseen) set({ items, unseen });
  if (items.length && !b.autoOpened && b.baseline !== null) {
    b.autoOpened = true;
    openTray();
  }
}

/** Write this script's last-seen time and dismissals. Skips a write that would say what is already stored. */
function persist(b: Bound): void {
  if (!b.key) return;
  const previous = readSeen(app.setting<unknown>(b.key, null));
  const seenAt = nextSeenAt(Date.now(), previous?.seenAt ?? null, trayItemsOf(b), b.shown);
  const existing = new Set(records(b.session.doc, undefined, true).map((r) => r.id));
  const memory: SeenMemory = { seenAt, dismissed: pruneDismissed(b.dismissed, existing) };
  const json = JSON.stringify(memory);
  if (json === b.lastWritten) return;
  b.lastWritten = json;
  void app.setSetting(b.key, memory).catch(() => undefined);
}

function trayItemsOf(b: Bound): ProjectRecord[] {
  return trayNotes({ records: records(b.session.doc, "note"), baseline: b.baseline, dismissed: b.dismissed, own });
}

async function attach(session: DocumentSession): Promise<void> {
  const key = await settingKey(session);
  if (app.session !== session || bound?.session !== session || bound.key) return;
  const b = bound;
  b.key = key;
  if (!key) return;
  const memory = readSeen(app.setting<unknown>(key, null));
  // A script this Mac hasn't seen: its existing notes stay out of the tray, but notes arriving from now on show.
  b.baseline = memory?.seenAt ?? b.opened;
  b.dismissed = new Set(memory?.dismissed ?? []);
  refresh(b);
  persist(b);
}

/** The writer opened a script: take its baseline, then follow its notes. */
export function bindSession(session: DocumentSession): void {
  unbind();
  const b: Bound = { session, key: null, baseline: null, opened: Date.now(), dismissed: new Set(), shown: new Set(), autoOpened: false, lastWritten: "", off: () => {} };
  bound = b;
  const onMeta = () => refresh(b);
  session.doc.meta.observe(onMeta);
  // A script saved for the first time gets its identity here: try again when its name or path changes.
  const offState = session.onState(() => void attach(session));
  const timer = setInterval(() => persist(b), HEARTBEAT_MS);
  b.off = () => {
    session.doc.meta.unobserve(onMeta);
    offState();
    clearInterval(timer);
  };
  void attach(session);
}

/** The writer left the script (another document, or the window is closing): remember when. */
export function unbind(): void {
  const b = bound;
  if (!b) return;
  persist(b);
  b.off();
  bound = null;
  set(EMPTY);
}

/** The window is going away. */
export function saveSeen(): void {
  if (bound) persist(bound);
}

export function openTray(): void {
  set({ open: true });
  if (!bound) return;
  for (const item of state.items) bound.shown.add(item.id);
  set({ unseen: 0 });
}

export function closeTray(): void {
  set({ open: false });
}

export function dismissNote(record: ProjectRecord): void {
  if (!bound) return;
  bound.dismissed.add(record.id);
  refresh(bound);
  persist(bound);
}

function latest(session: DocumentSession, id: string): ProjectRecord {
  const found = records(session.doc, "note").find((r) => r.id === id);
  if (!found) throw new Error("This note is gone.");
  return found;
}

function change(record: ProjectRecord, patch: Partial<ProjectRecord>): void {
  const session = app.session;
  if (bound?.session !== session) throw new Error("The open script changed.");
  const current = latest(session, record.id);
  session.undo.stopCapturing();
  session.edit(() => putRecord(session.doc, { ...current, ...patch }, current.revision));
  session.undo.stopCapturing();
}

export function resolveNote(record: ProjectRecord): void {
  change(record, { resolved: true });
}

/** Attach the note to the writer's selection, or the line the caret is on. Throws a plain sentence when there is neither. */
export function pinNote(record: ProjectRecord): void {
  const session = app.session;
  const anchor = captureAnchor(session, app.editor?.getSelection(), app.editor?.currentParagraphId());
  if (!anchor) throw new Error("Place the caret in the script first.");
  change(record, { anchor });
}
