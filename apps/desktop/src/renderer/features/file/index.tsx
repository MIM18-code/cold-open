// New, Open, Save, Save As, Import, Export (FDX, Fountain and Movie Magic), Revert, recent files,
// crash-recovery backups, and asking to save before a window closes. PDF export lives in the print feature.
import { assertUniqueSceneNumbers, isTemplateId, ScreenplayDoc, parseFdx, parseFountain, plainText, sceneEighths, sexFromScript, writeFdx, writeFountain, writeSex, type Script } from "@screenplay/engine";
import { useEffect, useState, useSyncExternalStore } from "react";

import { CHANNELS, NATIVE_EXTENSION, type OpenedFile } from "../../../shared/api.ts";
import { app, type App, type Feature, type ModalProps } from "../../core/app.ts";
import { useSessionState } from "../../core/hooks.ts";
import { nativeOnlyFeatures } from "./preflight.ts";
import { decodeNative, encodeNative, isNative, mergeNativeFromDisk, metaAfterMerge, sharesHistory } from "../../core/fileformat.ts";
import { desktop, isDesktop, messageBox } from "../../core/platform.ts";
import { currentPagination } from "../print/live.ts";
import { titleFields } from "../title-page/titlepage.ts";
import { historyId, recordVersion } from "../history/index.tsx";
import { resolveSceneNumbersForDelivery } from "../revisions/settle.ts";
import { chooseTableReadStorage, restoreTableReadForOpen, writeTableReadSidecar } from "../table-read/sidecar-files.ts";
import { persistProductionBaseline, prepareProductionBaselineSave, productionHeadingIdentities, restoreProductionBaseline, sessionBaseline } from "../backlot/baseline.ts";
import { DocumentSession, type SourceFormat } from "../../core/session.ts";

const OPEN_FILTERS = [
  { name: "Screenplays", extensions: [NATIVE_EXTENSION, "fdx", "fountain", "spmd", "txt"] },
  { name: "All files", extensions: ["*"] },
];
const NATIVE_FILTER = [{ name: "Screenplay", extensions: [NATIVE_EXTENSION] }];
const BACKUP_INTERVAL = 30_000;

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function formatOf(name: string, data: Uint8Array): SourceFormat {
  // A .screenplay file must decode as one; a damaged one is an error, never re-read as Fountain.
  if (isNative(data) || name.toLowerCase().endsWith(`.${NATIVE_EXTENSION}`)) return "screenplay";
  if (/\.fdx$/i.test(name)) return "fdx";
  const head = new TextDecoder().decode(data.subarray(0, 400));
  if (/<FinalDraft[\s>]/.test(head)) return "fdx";
  return "fountain";
}

/** Read a file of any supported format into a session. */
export function sessionFromFile(file: OpenedFile): DocumentSession {
  const format = formatOf(file.name, file.data);
  const name = baseName(file.name);
  if (format === "screenplay") {
    const { doc } = decodeNative(file.data);
    const session = new DocumentSession(doc, { path: file.path, format, name });
    session.undo.clear();
    session.dirty = false;
    session.fileHash = file.fileHash ?? null;
    return session;
  }
  const text = new TextDecoder().decode(file.data);
  const warnings: string[] = [];
  const script: Script = format === "fdx" ? parseFdx(text, { warnings }) : parseFountain(text);
  const session = new DocumentSession(ScreenplayDoc.fromScript(script), { path: file.path, format, name });
  session.undo.clear();
  session.dirty = false;
  session.fileHash = file.fileHash ?? null;
  if (warnings.length) app.toast(`Opened with ${warnings.length} repair${warnings.length === 1 ? "" : "s"}: ${warnings[0]}`, "info");
  return session;
}

async function restoredSessionFromFile(file: OpenedFile): Promise<DocumentSession> {
  const session = sessionFromFile(file);
  try { await restoreProductionBaseline(session); }
  catch (error) { app.toast(`Could not restore the production baseline: ${String(error)}`, "error"); }
  return session;
}

/** Serialize the session in a format. */
export function serialize(session: DocumentSession, format: SourceFormat): Uint8Array | string {
  if (format === "screenplay") return encodeNative(session.doc, session.name);
  const warnings: string[] = [];
  const script = session.script();
  if (format === "fdx") {
    const xml = writeFdx(script, { warnings });
    if (warnings.length) {
      const items = `${warnings.length} item${warnings.length === 1 ? "" : "s"}`;
      // Skipped notes, sections and synopses are the usual reason; anything else (control characters, a locked
      // page whose text is gone) is named.
      const other = warnings.find((warning) => !warning.startsWith("Skipped "));
      app.toast(other
        ? `Final Draft can't hold ${items} in this script: ${other}`
        : `Final Draft can't hold ${items} (notes, sections or synopses outside a scene heading); they were left out.`, "info");
    }
    return xml;
  }
  // A script opened from Final Draft keeps its title page as Final Draft's XML; Fountain needs it as fields.
  return writeFountain({ ...script, titlePage: titleFields(script) });
}

function nextDocumentChannel(): string {
  return desktop.platform === "darwin" && app.setting("workspace.openInTabs", true) ? CHANNELS.newTab : CHANNELS.newWindow;
}

/** A sidecar is a convenience; a damaged one must never stop a script from opening. */
async function restoreAfterOpen(session: DocumentSession): Promise<void> {
  try { await restoreTableReadForOpen(session); }
  catch (error) { app.toast(error instanceof Error ? error.message : String(error), "error"); }
}

/** Keep the deliberate table-read choice out of the save itself; a failure here never invalidates the save. */
async function writeTableReadAfterSave(session: DocumentSession, target: App): Promise<void> {
  try { await writeTableReadSidecar(session); }
  catch (error) { target.toast(`Saved the script, but not the table read: ${error instanceof Error ? error.message : String(error)}`, "error"); }
}

async function openFile(file: OpenedFile): Promise<void> {
  app.flushPending();
  if (!app.session.pristine) {
    await desktop.invoke(nextDocumentChannel(), file.path);
    return;
  }
  const waitingIn = app.session;
  const opened = await restoredSessionFromFile(file);
  if (app.session !== waitingIn || !app.session.pristine) {
    await desktop.invoke(nextDocumentChannel(), file.path);
    return;
  }
  app.setSession(opened);
  await desktop.invoke(CHANNELS.addRecent, file.path);
  await restoreAfterOpen(app.session);
}

async function openPath(path: string): Promise<void> {
  if (app.session.path === path) return;
  app.flushPending();
  if (!app.session.pristine) {
    await desktop.invoke(nextDocumentChannel(), path);
    return;
  }
  const waitingIn = app.session;
  const file = await desktop.invoke<OpenedFile>(CHANNELS.readFile, path);
  const opened = await restoredSessionFromFile(file);
  // The writer may have started typing, or another open may have landed, while the file was read.
  if (app.session !== waitingIn || !app.session.pristine) {
    if (app.session.path !== path) await desktop.invoke(nextDocumentChannel(), path);
    return;
  }
  app.setSession(opened);
  await desktop.invoke(CHANNELS.addRecent, path);
  await restoreAfterOpen(app.session);
}

const exchangeAcknowledgments = new WeakMap<DocumentSession, Set<string>>();
async function confirmExchange(session: DocumentSession, format: SourceFormat): Promise<boolean> {
  if (format === "screenplay") return true;
  const lost = nativeOnlyFeatures(session.doc);
  if (!lost.length) return true;
  const key = format + ":" + lost.join("|");
  if (exchangeAcknowledgments.get(session)?.has(key)) return true;
  const version = session.version;
  const response = await messageBox({ type: "warning", message: `This ${format.toUpperCase()} file cannot keep all project material.`,
    detail: lost.join("\n") + "\n\nThe screenplay text is retained, but these items will not be present when reopening the exchange file. Save a .screenplay master first to keep them. Cancel does not write the file.",
    buttons: ["Continue exchange save", "Cancel and keep working"], defaultId: 1, cancelId: 1 });
  if (response !== 0) return false;
  if (app.session !== session || session.version !== version) throw new Error("The draft changed during export review. Review the current version before saving.");
  let acknowledged = exchangeAcknowledgments.get(session); if (!acknowledged) { acknowledged = new Set(); exchangeAcknowledgments.set(session,acknowledged); }
  acknowledged.add(key); return true;
}
/** Origin for disk state merged in before a save; like sync updates, it is not undoable. */
const DISK_MERGE_ORIGIN = Symbol("disk-merge");
const saveQueues = new WeakMap<DocumentSession, Promise<unknown>>();
async function saveTo(session: DocumentSession, path: string, format: SourceFormat, samePathOnly = false, stillCurrent: () => boolean = () => true): Promise<boolean> {
  const write = async () => {
    if (samePathOnly && (session.path !== path || session.format !== "screenplay" || session.readOnly || !stillCurrent())) return false;
  const expectedHash = session.path === path ? session.fileHash ?? undefined : undefined;
  // A native file carries its local-history identity, so snapshots taken later never have to write one into a
  // clean document and leave it looking edited.
  if (format === "screenplay") historyId(session, true);
  prepareProductionBaselineSave(session, format);
  const savedHeadings = productionHeadingIdentities(session);
  let version = session.version;
  let hash: string;
  try {
    hash = await desktop.invoke<string>(CHANNELS.writeFile, path, serialize(session, format), expectedHash);
  } catch (error) {
    // Another Mac syncing through the same folder, or another window, saved this .screenplay since we last did.
    // When it shares our history, merge what it has and save over it; anything else still goes to the writer.
    if (!String(error).includes("FILE_CHANGED:") || format !== "screenplay" || session.path !== path) throw error;
    const disk = await desktop.invoke<OpenedFile>(CHANNELS.readFile, path);
    if (samePathOnly && !stillCurrent()) return false;
    if (!disk.fileHash || !sharesHistory(session.doc, disk.data)) throw error;
    // The merge brings in the other copy's deletions too, and the save then replaces the only file on disk, so
    // keep this window's version in Draft History first. Without that copy, leave the decision to the writer.
    const label = "Before merging another copy";
    const before = encodeNative(session.doc, session.name);
    const idBefore = historyId(session, true);
    if (!idBefore) throw error;
    // Each copy may have written its own history ID and the merge keeps one, so file the snapshot under that too.
    const idAfter = metaAfterMerge(session.doc, disk.data, "history.documentId");
    try {
      await recordVersion(idBefore, label, before);
      if (typeof idAfter === "string" && idAfter !== idBefore) await recordVersion(idAfter, label, before);
    } catch {
      throw error;
    }
    const merged = mergeNativeFromDisk(session.doc, disk.data, DISK_MERGE_ORIGIN);
    if (merged === "unrelated") throw error;
    if (merged === "merged") {
      app.toast("Merged changes from another copy of this script. Your version before the merge is in Draft History.", "info");
    }
    version = session.version;
    hash = await desktop.invoke<string>(CHANNELS.writeFile, path, serialize(session, format), disk.fileHash);
  }
  // A save represents a specific document version even if a collaborator changes the draft mid-write.
  const productionBaseline = sessionBaseline(session);
  session.fileHash = hash;
  session.markSaved(path, format, baseName(path.split("/").pop() ?? path), version);
  try { await persistProductionBaseline(session, productionBaseline, savedHeadings); }
  catch (error) { app.toast(`Saved the script, but not the production baseline: ${String(error)}`, "error"); }
  await desktop.invoke(CHANNELS.addRecent, path);
  if (!session.dirty) void clearBackup(session);
  return true;
  };
  const next = (saveQueues.get(session) ?? Promise.resolve()).catch(() => undefined).then(write);
  saveQueues.set(session, next);
  try { return await next; } finally { if (saveQueues.get(session) === next) saveQueues.delete(session); }
}
/** Optional in-place saving is native-only and never opens a dialog or overwrites an external edit. */
export async function autosaveNative(target: App = app): Promise<boolean> {
  target.flushPending(); const session = target.session;
  if (!isDesktop || !session.path || session.format !== "screenplay" || session.readOnly || !session.dirty || !session.fileHash) return false;
  return saveTo(session, session.path, "screenplay", true, () => target.session === session);
}

export async function save(target: App = app): Promise<boolean> {
  // A section title or synopsis still being typed goes into the document first, so Save writes what the writer sees.
  target.flushPending();
  const session = target.session;
  if (!session.path || session.path.startsWith("browser:") && !isDesktop) return saveAs(target);
  try {
    if ((await chooseTableReadStorage(session)) === "master") return saveAs(target, "screenplay");
    if (!(await confirmExchange(session, session.format))) return false;
    await saveTo(session, session.path, session.format);
    await writeTableReadAfterSave(session, target);
    return true;
  } catch (error) {
    if (!String(error).includes("FILE_CHANGED:")) throw error;
    const choice = await messageBox({
      type: "warning", message: "This script was changed outside this window.",
      detail: "Your edits are still here. To avoid overwriting the other version, save a separate copy or deliberately reload the file.",
      buttons: ["Save a copy…", "Reload disk version…", "Cancel"], defaultId: 0, cancelId: 2,
    });
    if (choice === 0) return saveAs(target, session.format);
    if (choice === 1) {
      const yes = await messageBox({
        type: "warning", message: "Replace your unsaved draft with the disk version?",
        detail: "Any changes not present in the disk file will be lost. Save a copy instead to keep both.",
        buttons: ["Keep my draft", "Reload disk version"], defaultId: 0, cancelId: 0,
      });
      if (yes !== 1 || target.session !== session) return false;
      target.setSession(await restoredSessionFromFile(await desktop.invoke<OpenedFile>(CHANNELS.readFile, session.path!)));
      return true;
    }
    return false;
  }
}

export async function saveAs(target: App = app, format: SourceFormat = "screenplay"): Promise<boolean> {
  target.flushPending();
  const session = target.session;
  if (format !== "screenplay" && (await chooseTableReadStorage(session)) === "master") return saveAs(target, "screenplay");
  if (!(await confirmExchange(session, format))) return false;
  const extension = format === "screenplay" ? NATIVE_EXTENSION : format;
  const path = await desktop.invoke<string | null>(CHANNELS.saveDialog, {
    title: format === "screenplay" ? "Save" : `Export ${format === "fdx" ? "Final Draft" : "Fountain"}`,
    defaultPath: `${session.name}.${extension}`,
    filters: format === "screenplay" ? NATIVE_FILTER : [{ name: format === "fdx" ? "Final Draft" : "Fountain", extensions: [extension] }],
  });
  if (!path) return false;
  await saveTo(session, path, format);
  await writeTableReadAfterSave(session, target);
  return true;
}

async function exportAs(format: "fdx" | "fountain"): Promise<void> {
  app.flushPending();
  const session = app.session;
  resolveSceneNumbersForDelivery(session);
  assertUniqueSceneNumbers(session.script());
  if (!(await confirmExchange(session, format))) return;
  // Deliver the exact checked version even if a co-writer edits while the save dialog is open.
  assertUniqueSceneNumbers(session.script());
  const data = serialize(session, format);
  const path = await desktop.invoke<string | null>(CHANNELS.saveDialog, {
    title: `Export ${format === "fdx" ? "Final Draft" : "Fountain"}`,
    defaultPath: `${session.name}.${format}`,
    filters: [{ name: format === "fdx" ? "Final Draft" : "Fountain", extensions: [format] }],
  });
  if (!path) return;
  await desktop.invoke(CHANNELS.writeFile, path, data);
  app.toast(`Exported ${path.split("/").pop()}`, "success");
}

async function exportSex(): Promise<void> {
  app.flushPending();
  const session = app.session;
  resolveSceneNumbersForDelivery(session);
  assertUniqueSceneNumbers(session.script());
  // toScript already projects tags authored in the app, so their definitions resolve here.
  const script = session.script();
  const pagination = currentPagination(app, script), pages = new Map<string, string>();
  for (const page of pagination.pages) {
    for (const sceneId of page.sceneIds) if (!pages.has(sceneId)) pages.set(sceneId, page.number);
  }
  // Scene lengths fill Movie Magic's page-count column; they're the same eighths the Scenes report shows.
  const data = writeSex(sexFromScript(script, { pages, lengths: sceneEighths(script, pagination) }));
  const path = await desktop.invoke<string | null>(CHANNELS.saveDialog, {
    title: "Export Movie Magic Scheduling",
    defaultPath: `${session.name}.sex`,
    filters: [{ name: "Movie Magic Scheduling", extensions: ["sex"] }],
  });
  if (!path) return;
  await desktop.invoke(CHANNELS.writeFile, path, data);
  app.toast(`Exported ${path.split("/").pop()}`, "success");
}

/** Ask to save unsaved changes. Resolves true when it is fine to discard the document. */
export async function confirmDiscard(action = "closing"): Promise<boolean> {
  // A pending draft makes the document dirty, so closing asks instead of dropping it.
  app.flushPending();
  const session = app.session;
  if (!session.dirty) return true;
  const choice = await messageBox({
    type: "warning",
    message: `Save changes to "${session.name}" before ${action}?`,
    detail: "Your changes are lost if you don't save them.",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice === 2) return false;
  if (choice === 0) return (await save()) && !app.session.dirty;
  return true;
}

// Recovery is separate from saving the original document. Keep failures visible until a successful retry.
type RecoveryHealth = { state: "waiting" | "saved" | "error"; at?: number; reason?: string };
const waitingRecovery: RecoveryHealth = { state: "waiting" };
const recoveryResults = new Map<string, RecoveryHealth>();
const recoveryListeners = new Set<() => void>();
const recoveryBusy = new Set<string>();
function updateRecovery(id: string, value: RecoveryHealth): void {
  recoveryResults.set(id, value);
  for (const listener of recoveryListeners) listener();
}
function RecoveryStatus() {
  const { dirty } = useSessionState();
  const health = useSyncExternalStore(
    (onChange) => { recoveryListeners.add(onChange); return () => recoveryListeners.delete(onChange); },
    () => recoveryResults.get(app.session.id) ?? waitingRecovery,
  );
  if (!isDesktop || !dirty) return null;
  if (health.state === "error") {
    return <button className="recovery-health recovery-health-error" title={health.reason} aria-label={`Recovery backup failed: ${health.reason}. Retry now`}
      onClick={() => void runBackup(app.session)}>Recovery failed · Retry</button>;
  }
  if (health.state === "saved" && health.at) return <span className="recovery-health" title={`Recovery copy saved ${new Date(health.at).toLocaleString()}. Save the script to update the original file.`}>
    Recovery copy saved</span>;
  return <span className="recovery-health" title="Unsaved edits will be backed up automatically. Save to update the original file.">Recovery pending</span>;
}
// Crash recovery: a dirty document is copied to userData/autosave every 30 seconds.
async function backupPath(session: DocumentSession): Promise<string | null> {
  if (!isDesktop) return null;
  const dir = await desktop.invoke<string>("files:autosave-dir");
  return `${dir}/${session.id}.${NATIVE_EXTENSION}`;
}
async function writeBackup(session: DocumentSession): Promise<void> {
  if (!session.dirty || !isDesktop) return;
  const path = await backupPath(session);
  if (!path) return;
  await desktop.invoke(CHANNELS.writeFile, path, encodeNative(session.doc, session.name));
}
async function runBackup(session: DocumentSession): Promise<void> {
  if (!session.dirty || !isDesktop || recoveryBusy.has(session.id)) return;
  recoveryBusy.add(session.id);
  try {
    await writeBackup(session);
    updateRecovery(session.id, { state: "saved", at: Date.now() });
  } catch (error) {
    updateRecovery(session.id, { state: "error", reason: error instanceof Error ? error.message : String(error) });
  } finally {
    recoveryBusy.delete(session.id);
  }
}
async function clearBackup(session: DocumentSession): Promise<void> {
  const path = await backupPath(session);
  if (path) await desktop.invoke("files:remove-autosave", path).catch(() => undefined);
  if (session.recoveredFrom) {
    await desktop.invoke("files:remove-autosave", session.recoveredFrom).catch(() => undefined);
    session.recoveredFrom = null;
  }
}

/**
 * Load a crash-recovery copy as an unsaved document. The copy stays on disk until the recovered document is
 * saved or discarded, so nothing is lost if the window closes or the app crashes again first.
 */
async function recoverPath(path: string): Promise<void> {
  app.flushPending();
  if (!app.session.pristine) {
    await desktop.invoke(CHANNELS.newWindow, path, "recover");
    return;
  }
  const file = await desktop.invoke<OpenedFile>(CHANNELS.readFile, path);
  if (!app.session.pristine) {
    await desktop.invoke(CHANNELS.newWindow, path, "recover");
    return;
  }
  const waitingIn = app.session;
  const session = await restoredSessionFromFile(file);
  if (app.session !== waitingIn || !app.session.pristine) {
    await desktop.invoke(CHANNELS.newWindow, path, "recover");
    return;
  }
  session.path = null;
  session.name = `${session.name} (recovered)`;
  session.recoveredFrom = path;
  session.markDirty();
  app.setSession(session);
}

function RecentModal({ close }: ModalProps) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void desktop.invoke<string[]>(CHANNELS.recentFiles).then((files) => { if (active) setPaths(files); },
      (failure) => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, []);
  return <div>
    {error && <p role="alert">{error}</p>}
    {paths === null ? <p className="empty-note">Loading recent scripts…</p> : paths.length === 0 ? <p className="empty-note">No recent files.</p> :
      <div className="file-choice-list">{paths.map((path) => (
        <button type="button" key={path} className="list-row file-choice" onClick={() => { close(); void openPath(path).catch((e) => app.toast(String(e), "error")); }}>
          <strong>{path.split("/").pop()}</strong><small>{path}</small>
        </button>
      ))}</div>}
  </div>;
}
interface RecoveryPreview { name: string; savedAt: string; preview: string; error?: string; }
function RecoverModal({ close, props }: ModalProps<{ files: string[] }>) {
  const [left, setLeft] = useState(props.files);
  const [details, setDetails] = useState<Record<string, RecoveryPreview>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    // Existing native snapshots already contain their title and savedAt in the header.
    // A corrupt snapshot remains in the list, so the writer can retain it for support.
    void Promise.all(left.map(async (path) => {
      try {
        const file = await desktop.invoke<OpenedFile>(CHANNELS.readFile, path);
        const { header, doc } = decodeNative(file.data);
        const preview = doc.toScript().paragraphs.map((p) => plainText(p.runs).trim()).filter(Boolean).slice(0, 3).join(" · ").slice(0, 240);
        doc.ydoc.destroy();
        return [path, { name: header.title || "Unnamed draft", savedAt: header.savedAt || "", preview }] as const;
      } catch (failure) {
        return [path, { name: "Recovery copy", savedAt: "", preview: "Preview unavailable; the file is retained.", error: String(failure) }] as const;
      }
    })).then((items) => { if (active) setDetails(Object.fromEntries(items)); });
    return () => { active = false; };
  }, [left]);
  const recover = async (path: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await recoverPath(path);
      const rest = left.filter((p) => p !== path);
      setLeft(rest);
      if (!rest.length) close();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const discard = async () => {
    if (busy || !left.length) return;
    const choice = await messageBox({
      type: "warning", message: `Discard ${left.length} recovery ${left.length === 1 ? "copy" : "copies"}?`,
      detail: "These unsaved drafts will be permanently deleted. Cancel keeps them for later.",
      buttons: ["Keep copies", "Discard copies"], defaultId: 0, cancelId: 0,
    });
    if (choice !== 1) return;
    setBusy(true); setError("");
    try {
      for (const path of left) await desktop.invoke("files:remove-autosave", path);
      setLeft([]); close();
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  return <div>
    <p>We found unsaved work from another session. Choose a draft to recover, or keep these copies for later.</p>
    {error && <p role="alert">{error}</p>}
    <div className="file-choice-list">{left.map((path) => {
      const info = details[path];
      return <button type="button" key={path} className="list-row file-choice" disabled={busy} onClick={() => void recover(path)}>
        <strong>{info?.name ?? "Loading draft…"}</strong>
        {info?.savedAt ? <small>Recovery copy: {new Date(info.savedAt).toLocaleString()}</small> : null}
        {info?.preview ? <span>{info.preview}</span> : null}
        {info?.error ? <small>{info.error}</small> : null}
      </button>;
    })}</div>
    <div className="modal-actions">
      <button type="button" className="button" disabled={busy} onClick={close}>Keep for later</button>
      <button type="button" className="button" disabled={busy || !left.length} onClick={() => void discard()}>Discard copies…</button>
    </div>
  </div>;
}

const feature: Feature = {
  id: "file",
  commands: [
    { id: "file.new", label: "New", menu: "File", group: "new", accelerator: "CmdOrCtrl+N", run: async (a) => {
      a.flushPending();
      if (a.session.pristine) return;
      if (isDesktop) await desktop.invoke(CHANNELS.newWindow);
      else if (await confirmDiscard("starting a new script")) a.setSession(DocumentSession.untitled());
    } },
    { id: "file.open", label: "Open…", menu: "File", group: "new", accelerator: "CmdOrCtrl+O", run: async () => {
      const [file] = await desktop.invoke<OpenedFile[]>(CHANNELS.openDialog, { title: "Open", filters: OPEN_FILTERS });
      if (file) await openFile(file);
    } },
    { id: "file.recent", label: "Open Recent…", menu: "File", group: "new", run: (a) => a.openModal("file.recent") },
    { id: "file.save", label: "Save", menu: "File", group: "save", accelerator: "CmdOrCtrl+S", run: (a) => save(a) },
    { id: "file.saveAs", label: "Save As…", menu: "File", group: "save", accelerator: "CmdOrCtrl+Shift+S", run: (a) => saveAs(a) },
    { id: "file.revert", label: "Revert to Saved", menu: "File", group: "save",
      enabled: (a) => !!a.session.path && a.session.dirty,
      run: async (a) => {
        const path = a.session.path!;
        const choice = await messageBox({ message: `Revert "${a.session.name}" to the saved version?`, detail: "Your unsaved changes will be lost.", buttons: ["Revert", "Cancel"], cancelId: 1 });
        if (choice !== 0) return;
        const file = await desktop.invoke<OpenedFile>(CHANNELS.readFile, path);
        const session = await restoredSessionFromFile(file);
        a.setSession(session);
        await restoreAfterOpen(session);
      } },
    { id: "file.exportFdx", label: "Export Final Draft (.fdx)…", menu: "File", group: "export", run: () => exportAs("fdx") },
    { id: "file.exportSex", label: "Export Movie Magic Scheduling (.sex)…", menu: "File", group: "export", run: () => exportSex() },
    { id: "file.exportFountain", label: "Export Fountain…", menu: "File", group: "export", run: () => exportAs("fountain") },
    { id: "file.reveal", label: "Show in Finder", menu: "File", group: "export", enabled: (a) => !!a.session.path && isDesktop,
      run: (a) => desktop.invoke(CHANNELS.revealInFinder, a.session.path) },
  ],
  status: [{ id: "file.recovery", order: 5, component: RecoveryStatus }],
  modals: [
    { id: "file.recent", title: "Open Recent", width: 520, component: RecentModal },
    { id: "file.recover", title: "Recover unsaved scripts", width: 520, component: RecoverModal },
  ],
  activate(a) {
    // Window title, edited dot and proxy icon.
    const syncTitle = () => {
      const s = a.session;
      void desktop.invoke(CHANNELS.setWindowState, { title: s.name, edited: s.dirty, ...(s.path ? { path: s.path } : {}) });
      a.refreshMenu();
    };
    let offState = a.session.onState(syncTitle);
    a.onSession((session, previous) => {
      offState();
      offState = session.onState(syncTitle);
      syncTitle();
      void clearBackup(previous);
    });
    syncTitle();

    desktop.on(CHANNELS.openPath, (path) => void openPath(path as string).catch((error) => a.toast(String(error.message ?? error), "error")));
    desktop.on(CHANNELS.closeRequested, async () => {
      if (await confirmDiscard()) {
        await clearBackup(a.session);
        await desktop.invoke(CHANNELS.closeAllowed);
      } else await desktop.invoke("shell:close-cancelled");
    });
    if (!isDesktop) {
      window.addEventListener("beforeunload", (event) => {
        if (a.session.dirty) event.preventDefault();
      });
    }

    const params = new URLSearchParams(location.search);
    const initial = params.get("open");
    const recovering = params.get("recover");
    const template = params.get("template");
    if (initial) void openPath(initial).catch((error) => a.toast(`Couldn't open ${initial.split("/").pop()}: ${error.message ?? error}`, "error"));
    if (recovering) void recoverPath(recovering).catch((error) => a.toast(`Couldn't recover the script: ${error.message ?? error}`, "error"));
    // A new window opened from New from Template starts on that template's layout and act structure.
    if (!initial && !recovering && isTemplateId(template)) a.setSession(DocumentSession.untitled(template));
    // Tell the main process this window now receives open-file messages (it queues them until then).
    void desktop.invoke("shell:renderer-ready").catch(() => undefined);

    setInterval(() => void runBackup(a.session), BACKUP_INTERVAL);
    // Only the first window offers recovery, so two windows don't both claim the same backups.
    if (isDesktop && !initial && !recovering) {
      void desktop.invoke<string[]>("files:list-autosaves").then((files) => {
        if (files.length) a.openModal("file.recover", { files });
      });
    }
  },
};

export default feature;
