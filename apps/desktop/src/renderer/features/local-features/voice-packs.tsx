import { useEffect, useRef, useState } from "react";
import { CHANNELS } from "../../../shared/api.ts";
import { TABLE_READ, type ModelProgress, type ReaderStatus, type VoicePackState } from "../../../shared/channels/table-read.ts";
import { desktop } from "../../core/platform.ts";
import { downloadSize, memoryWarning, packPurpose, VOICES_CHANGED } from "../table-read/voice-setup.ts";

export function VoicePacks() {
  const [packs, setPacks] = useState<VoicePackState[]>([]), [status, setStatus] = useState<ReaderStatus>();
  const [confirm, setConfirm] = useState<string>(), [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState<string>(), [progress, setProgress] = useState<ModelProgress>();
  const [errors, setErrors] = useState<Record<string, string>>({}), [error, setError] = useState("");
  const active = useRef<string | undefined>(undefined);
  const refresh = async () => {
    const [models, reader] = await Promise.all([desktop.invoke<VoicePackState[]>(TABLE_READ.models), desktop.invoke<ReaderStatus>(TABLE_READ.status)]);
    setPacks(models); setStatus(reader);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    const off = desktop.on("table-read:model-progress", (value) => setProgress(value as ModelProgress));
    const offChanged = desktop.on(TABLE_READ.modelsChanged, () => { void refresh().catch((e) => setError(String(e))); });
    return () => { off(); offChanged(); if (active.current) void desktop.invoke(TABLE_READ.cancel).catch(() => {}); };
  }, []);
  const changed = async () => { await refresh(); window.dispatchEvent(new Event(VOICES_CHANGED)); };
  const install = async (pack: VoicePackState) => {
    if (active.current) return;
    active.current = pack.id; setBusy(pack.id); setProgress(undefined); setConfirm(undefined);
    setErrors((old) => ({ ...old, [pack.id]: "" }));
    try { await desktop.invoke(TABLE_READ.install, pack.id, true, allow); }
    catch (e) { setErrors((old) => ({ ...old, [pack.id]: `${String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, "")} Retry keeps what already downloaded.` })); }
    finally { active.current = undefined; setBusy(undefined); await changed().catch((e) => setError(String(e))); }
  };
  return <div aria-label="Voice packs">
    <p>Neural packs require Apple silicon and macOS 15+. Apple Premium voices are added in System Settings, under Accessibility, Spoken Content.</p>
    {packs.map((pack) => {
      const warning = memoryWarning(pack, status?.memoryGB), running = busy === pack.id;
      return <section className="rewrite-item" key={pack.id} aria-label={pack.label} style={{ marginBottom: 12 }}>
        <h4>{pack.label} <span className="voice-pack-state">{pack.installed ? "Installed" : pack.diskBytes ? "Incomplete" : ""}</span></h4>
        <p>{packPurpose(pack)}</p>
        <p className="voice-pack-meta">{pack.unresolved ? "Download unavailable" : downloadSize(pack.installed ? pack.diskBytes : pack.sizeBytes)} · needs {pack.memoryGB} GB memory · {(pack.licenseUrls ?? []).length
          ? (pack.licenseUrls ?? []).map((url, i) => <button key={url} className="voice-pack-license" onClick={() => void desktop.invoke(CHANNELS.openExternal, url).catch((e) => setError(String(e)))}>{i === 0 ? pack.license : `notice ${i + 1}`}</button>)
          : pack.license}</p>
        {warning && <p role="note">{warning}</p>}
        {pack.unresolved && <p role="alert">{pack.unresolved}</p>}
        {errors[pack.id] && <p role="alert">{errors[pack.id]}</p>}
        {!pack.installed && confirm !== pack.id && <button className="button" disabled={!!busy || !!pack.unresolved} onClick={() => { setConfirm(pack.id); setAllow(false); }}>{errors[pack.id] ? "Retry…" : pack.diskBytes ? "Resume install…" : "Install…"}</button>}
        {pack.diskBytes > 0 && <button className="button" disabled={!!busy} onClick={() => {
          active.current = pack.id; setBusy(pack.id);
          void desktop.invoke(TABLE_READ.remove, pack.id).then(changed).catch((e) => setErrors((old) => ({ ...old, [pack.id]: String(e) }))).finally(() => { active.current = undefined; setBusy(undefined); });
        }}>Remove</button>}
        {confirm === pack.id && <div role="group" aria-label={`Confirm ${pack.label} download`}>
          <p>Download {downloadSize(pack.sizeBytes)} ({pack.license})? Only the voice model downloads; your script stays on this Mac.</p>
          <p>{pack.provenance}</p>
          {warning && <label><input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)}/>Install anyway with less memory</label>}
          <button className="button primary" disabled={!!busy || (!!warning && !allow)} onClick={() => void install(pack)}>Confirm download</button>
          <button className="button" onClick={() => setConfirm(undefined)}>Back</button>
        </div>}
        {running && <div role="status"><progress aria-label={`Download ${pack.label}`} value={progress?.packId === pack.id ? progress.completedBytes : 0} max={progress?.packId === pack.id ? progress.totalBytes || 1 : pack.sizeBytes || 1}/>
          <span>{progress?.packId === pack.id ? `${downloadSize(progress.completedBytes)} / ${downloadSize(progress.totalBytes)}` : "Preparing…"}</span>
          <button className="button" onClick={() => void desktop.invoke(TABLE_READ.cancel).catch((e) => setError(String(e)))}>Cancel download</button>
        </div>}
      </section>;
    })}
    {error && <p role="alert">{error}</p>}
    <button className="button" disabled={!!busy} onClick={() => void refresh().catch((e) => setError(String(e)))}>Refresh voice packs</button>
  </div>;
}
