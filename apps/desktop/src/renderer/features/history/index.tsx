import { compareScripts, plainText, scenesOf, type Script } from "@screenplay/engine";
import { useEffect, useState } from "react";
import { HISTORY, type HistoryEntry } from "../../../shared/channels/history.ts";
import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { useSession, useSetting } from "../../core/hooks.ts";
import { decodeNative, encodeNative } from "../../core/fileformat.ts";
import { desktop, isDesktop, messageBox } from "../../core/platform.ts";
import type { DocumentSession } from "../../core/session.ts";
import { automaticSnapshotDue } from "./policy.ts";
import "./history.css";

const ID = "history.documentId";
export function historyId(session: DocumentSession, create = false): string | null {
  const value = session.doc.meta.get(ID);
  if (typeof value === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(value)) return value;
  if (!create || session.readOnly) return null;
  const id = crypto.randomUUID();
  // Document identity is not a creative edit: Undo must not detach a script from its saved history.
  session.doc.ydoc.transact(() => session.doc.meta.set(ID, id), "history-identity");
  return id;
}
export async function snapshot(session: DocumentSession, label: string, named = false): Promise<HistoryEntry> {
  if (!isDesktop) throw new Error("Local history requires the desktop app.");
  if (session.readOnly) throw new Error("Read-only scripts cannot create or restore history.");
  const documentId = historyId(session, true)!;
  return recordVersion(documentId, label, encodeNative(session.doc, session.name), named);
}
/** Store an already-encoded version under a history ID. */
export function recordVersion(documentId: string, label: string, data: Uint8Array, named = false): Promise<HistoryEntry> {
  return desktop.invoke<HistoryEntry>(HISTORY.record, { documentId, label, named, data });
}
function HistoryModal({ close }: ModalProps) {
  const session = useSession();
  const [entries, setEntries] = useState<HistoryEntry[]>([]), [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState<{ id: string; version: number; script: Script; summary: string; scenes: { id: string; title: string }[] } | null>(null);
  const [scene, setScene] = useState("");
  const refresh = async () => { const key = historyId(session); setEntries(key ? await desktop.invoke<HistoryEntry[]>(HISTORY.list, key) : []); };
  useEffect(() => { void refresh().catch((e) => setError(String(e))); }, [session]);
  const perform = (task: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError("");
    void task().catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const inspect = async (id: string) => {
    const data = await desktop.invoke<Uint8Array>(HISTORY.read, historyId(session), id);
    if (app.session !== session) throw new Error("The open document changed.");
    const saved = decodeNative(data), script = saved.doc.toScript(); saved.doc.ydoc.destroy();
    const diff = compareScripts(script, session.script());
    setScene("");
    setPreview({ id, version: session.version, script, summary: `${diff.counts.scenes.added} added scenes · ${diff.counts.scenes.omitted} removed · ${diff.counts.scenes.changed} changed · +${diff.counts.wordsAdded}/−${diff.counts.wordsDeleted} words`,
      scenes: scenesOf(script.paragraphs).map((s) => ({ id: s.sceneId, title: plainText(script.paragraphs[s.start]!.runs) })) });
  };
  const restore = async () => {
    if (!preview || session.readOnly || app.session !== session) return;
    const expected = session.version;
    if (expected !== preview.version) throw new Error("The draft changed while you were comparing. Preview this snapshot again before restoring.");
    const response = await messageBox({ type: "warning", message: scene ? "Restore this scene from the snapshot?" : "Restore this draft snapshot?", detail: "A new snapshot of your current draft will be kept first. The restoration is one undoable edit. Other versions are not removed.", buttons: ["Restore", "Cancel"], defaultId: 1, cancelId: 1 });
    if (response !== 0) return;
    if (session.version !== expected || app.session !== session) throw new Error("The draft changed. Preview again before restoring.");
    const raw = await desktop.invoke<Uint8Array>(HISTORY.read, historyId(session), preview.id);
    await snapshot(session, "Before restoring a snapshot");
    if (session.version !== expected || app.session !== session) throw new Error("The draft changed while saving its safety snapshot. Nothing was replaced.");
    const restored = decodeNative(raw);
    try {
      const source = restored.doc.toScript();
      session.undo.stopCapturing();
      session.edit(() => {
        if (scene) {
          const wanted = scenesOf(source.paragraphs).find((s) => s.sceneId === scene);
          const current = scenesOf(session.doc.paragraphs()).find((s) => s.sceneId === scene);
          if (!wanted || !current) throw new Error("This scene is no longer in the current script. Restore the whole draft or copy its text from the preview instead.");
          const present = session.doc.paragraphs();
          if (present.slice(current.start, current.end).some((p) => p.sceneNumber)) throw new Error("This is a numbered production scene. Remove or reconcile production locks before scene restoration.");
          const parts = source.paragraphs.slice(wanted.start, wanted.end);
          if (parts.some((p) => !current.paragraphIds.includes(p.id) && session.doc.has(p.id))) throw new Error("Some snapshot paragraphs were moved into another scene. Use whole-draft comparison before restoring.");
          for (const id of [...current.paragraphIds].reverse()) session.doc.deleteParagraph(id);
          parts.forEach((p, i) => session.doc.insertParagraph(current.start + i, p));
        } else {
          const metadata = restored.doc.meta.toJSON();
          for (const key of [...session.doc.meta.keys()]) if (key !== ID) session.doc.meta.delete(key);
          for (const [key, value] of Object.entries(metadata)) if (key !== ID) session.doc.meta.set(key, structuredClone(value));
          session.doc.load(source);
        }
      });
      session.undo.stopCapturing();
      app.toast(scene ? "Scene restored. Undo reverses the restoration." : "Draft restored. Your previous draft remains in local history.", "success");
      setPreview(null); await refresh();
    } finally { restored.doc.ydoc.destroy(); }
  };
  return <div className="history-browser">
    <p>History is stored privately on this Mac, separately from the screenplay. Up to 64 versions / 128 MB per document; up to 20 named snapshots are protected from automatic pruning.</p>
    {session.format !== "screenplay" && <p role="status">Save a .screenplay master to retain this document’s history identity across restarts. Exchange files cannot store the identity.</p>}
    <form onSubmit={(e) => { e.preventDefault(); perform(async () => { app.flushPending(); await snapshot(session, label, true); setLabel(""); await refresh(); }); }} className="history-create">
      <input aria-label="Snapshot name" placeholder="Before changing the opening" value={label} maxLength={160} onChange={(e) => setLabel(e.target.value)} />
      <button className="button primary" disabled={busy || session.readOnly || !label.trim()}>Save named snapshot</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <div className="history-list">{entries.map((entry) => <article key={entry.id}>
      <button className="button" disabled={busy} onClick={() => perform(() => inspect(entry.id))}><strong>{entry.label}</strong> · {new Date(entry.at).toLocaleString()}{entry.named ? " · named" : ""}</button>
      <button className="button" disabled={busy || session.readOnly} aria-label={`Remove snapshot ${entry.label}`} onClick={() => perform(async () => {
        const response = await messageBox({ type: "warning", message: `Remove “${entry.label}” from history?`, detail: "The current screenplay is not changed. This snapshot will be permanently removed.", buttons: ["Keep", "Remove"], defaultId: 0, cancelId: 0 });
        if (response === 1) { await desktop.invoke(HISTORY.remove, historyId(session), entry.id); if (preview?.id === entry.id) setPreview(null); await refresh(); }
      })}>Remove…</button>
    </article>)}</div>
    {!entries.length && <p>No snapshots yet. Name the current draft above to keep your first version.</p>}
    {preview && <section className="history-preview"><h3>Compared with the current draft</h3><p>{preview.summary}</p>
      <label className="field"><span>Restore scope</span><select aria-label="Snapshot restore scope" value={scene} onChange={(e) => setScene(e.target.value)}><option value="">Whole draft</option>{preview.scenes.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
      <pre tabIndex={0}>{(scene ? preview.script.paragraphs.slice(...(() => { const s = scenesOf(preview.script.paragraphs).find((s) => s.sceneId === scene)!; return [s.start, s.end] as const; })()) : preview.script.paragraphs).map((p) => plainText(p.runs)).join("\n\n").slice(0,30000)}</pre>
      <button className="button primary" disabled={busy || session.readOnly} onClick={() => perform(restore)}>Restore with safety snapshot…</button>
    </section>}
    <div className="modal-actions"><button className="button" onClick={close}>Close</button></div>
  </div>;
}
function HistorySettings() {
  const [automatic, setAutomatic] = useSetting("history.automatic", true);
  return <div><label><input type="checkbox" checked={automatic} onChange={(e) => void setAutomatic(e.target.checked)} /> Keep automatic local history for saved native documents</label><p>Changed native drafts are checked once a minute. Saving the original file and crash recovery remain separate. Named snapshots are never silently pruned.</p><button className="button" onClick={() => app.openModal("history.browser")}>Browse draft history</button></div>;
}
const feature: Feature = {
  id: "history", modals: [{ id: "history.browser", title: "Draft history", width: 860, component: HistoryModal }],
  commands: [{ id: "history.open", label: "Draft History / Named Snapshot…", menu: "File", group: "save", accelerator: "CmdOrCtrl+Shift+H", run: (a) => { a.flushPending(); a.openModal("history.browser"); } }],
  settings: [{ id: "history", title: "History & recovery", order: 18, component: HistorySettings }],
  activate(a) {
    const versions = new WeakMap<DocumentSession, number>(); let busy = false, lastError = "";
    const timer = setInterval(() => {
      const s = a.session;
      if (busy || !isDesktop || !s.path || s.format !== "screenplay" || s.readOnly || !a.setting("history.automatic", true)) return;
      if (!automaticSnapshotDue(versions, s)) return;
      busy = true; const version = s.version;
      void snapshot(s, "Automatic snapshot").then(() => { versions.set(s, version); lastError = ""; }, (e) => {
        const message = `Local history: ${e instanceof Error ? e.message : String(e)}`;
        if (message !== lastError) a.toast(message, "error"); lastError = message;
      }).finally(() => { busy = false; });
    }, 60_000);
    return () => clearInterval(timer);
  },
};
export default feature;
