import { useEffect, useRef, useState } from "react";
import { TABLE_READ, type DesignedAudition, type ReadVoice, type ReaderStatus } from "../../../shared/channels/table-read.ts";
import { app, type ModalProps } from "../../core/app.ts";
import { desktop, messageBox } from "../../core/platform.ts";
import { castForScript } from "./casting.ts";
import { readStoredCast, storedCharacter, writeCast } from "./cast-store.ts";
import { memoryWarning, VOICES_CHANGED } from "./voice-setup.ts";

interface DesignProps { session: string; character: string; name: string; }
export function VoiceDesign({ props, close }: ModalProps<DesignProps>) {
  const [description, setDescription] = useState(""), [share, setShare] = useState(false);
  const [audition, setAudition] = useState<DesignedAudition>(), [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mounted = useRef(true);
  // A failed publication leaves this design staged in main for another bind attempt.
  const staged = useRef<ReadVoice | undefined>(undefined);
  const original = useRef<{ voice?: string; locked: boolean } | undefined>(undefined);
  useEffect(() => () => {
    mounted.current = false;
    void desktop.invoke(TABLE_READ.cancel).then(() => desktop.invoke(TABLE_READ.design, { action: "discard" })).catch(() => {});
  }, []);
  useEffect(() => {
    if (!audition) { setUrl(""); return; }
    const source = URL.createObjectURL(new Blob([new Uint8Array(audition.audio)], { type: "audio/wav" }));
    setUrl(source); return () => URL.revokeObjectURL(source);
  }, [audition]);
  const check = () => {
    if (app.session.id !== props.session || app.session.readOnly) throw new Error("The document changed or is read-only. Reopen voice design from the character's row.");
    const binding = castForScript(app.session.script(), readStoredCast(app.session.doc)).state.cast.find((c) => c.id === props.character);
    if (!binding) throw new Error("This character is no longer in the script.");
    return binding;
  };
  if (!original.current) {
    const binding = castForScript(app.session.script(), readStoredCast(app.session.doc)).state.cast.find((c) => c.id === props.character);
    original.current = { voice: binding?.voices.qwen, locked: binding?.locked ?? false };
  }
  const generate = async () => {
    setBusy(true); setError(""); setAudition(undefined);
    try {
      check();
      if (staged.current) {
        await desktop.invoke(TABLE_READ.design, { action: "discard" });
        staged.current = undefined;
      }
      const status = await desktop.invoke<ReaderStatus>(TABLE_READ.status);
      if (!mounted.current) return;
      const pack = status.models?.find((p) => p.id === "qwen-design");
      if (!pack?.installed) throw new Error("Install Qwen VoiceDesign in Local features first.");
      const warning = memoryWarning(pack, status.memoryGB);
      if (warning && await messageBox({ type: "warning", message: "Load VoiceDesign with less memory?", detail: warning, buttons: ["Load anyway", "Cancel"], defaultId: 1, cancelId: 1 }) !== 0) return;
      if (!mounted.current) return;
      await desktop.invoke(TABLE_READ.prepare, "qwen-design", true, warning ? pack.id : undefined, true);
      if (!mounted.current) return;
      const result = await desktop.invoke<DesignedAudition>(TABLE_READ.design, { action: "preview", label: props.name,
        description: description.trim(), transcript: "The door was open when I arrived. I waited a moment, then stepped inside.", tags: [],
        provenance: `Cold Open VoiceDesign reference voice. Original description; no recorded person. ${share ? "Sharing permitted by the writer." : "Private; do not share."}` });
      if (mounted.current) setAudition(result);
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const confirmBinding = async () => {
    while (mounted.current) {
      const binding = check(), current = { voice: binding.voices.qwen, locked: binding.locked };
      if (original.current?.voice === current.voice && original.current?.locked === current.locked) return binding;
      if (await messageBox({ type: "warning", message: `Replace the changed voice for ${props.name}?`,
        detail: "The voice or lock changed while you were designing. Keep this design instead?", buttons: ["Replace voice", "Cancel"], defaultId: 1, cancelId: 1 }) !== 0) return;
      original.current = current;
    }
  };
  const checkedBinding = () => {
    const binding = check();
    if (binding.voices.qwen !== original.current?.voice || binding.locked !== original.current?.locked) throw new Error("The character's voice changed again. Keep the voice again to review it.");
    return binding;
  };
  const keep = async () => {
    if (!audition) return;
    setBusy(true); setError("");
    let saved = false, bound = false, retry = false;
    try {
      if (!await confirmBinding()) return;
      checkedBinding();
      const voice = staged.current ?? await desktop.invoke<ReadVoice>(TABLE_READ.design, { action: "keep", id: audition.id });
      staged.current = voice; saved = true;
      if (!mounted.current) return;
      if (!await confirmBinding() || !mounted.current) return;
      checkedBinding();
      try { await desktop.invoke(TABLE_READ.design, { action: "bind", id: voice.id }); }
      catch (e) { retry = true; throw e; }
      bound = true; staged.current = undefined;
      if (!mounted.current) return;
      setAudition(undefined);
      if (!await confirmBinding() || !mounted.current) return;
      const binding = checkedBinding();
      writeCast(app.session, { characters: [storedCharacter({ ...binding, locked: true }, { qwen: voice.id })] });
      await app.setSetting("tableRead.engine", "qwen");
      window.dispatchEvent(new Event(VOICES_CHANGED)); if (mounted.current) close();
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally {
      if (saved && !bound && (!retry || !mounted.current)) {
        await desktop.invoke(TABLE_READ.design, { action: "discard" }).catch((e) => { if (mounted.current) setError(String(e)); });
        staged.current = undefined;
        if (mounted.current) setAudition(undefined);
      }
      if (mounted.current) setBusy(false);
    }
  };
  return <div>
    <p>Describe how {props.name} should sound.</p>
    <label className="field"><span>Voice description</span><textarea aria-label="Voice description" maxLength={1000} value={description} disabled={busy} placeholder="Gravelly older man, tired, Boston" onChange={(e) => { setDescription(e.target.value); setAudition(undefined); }}/></label>
    <p className="reader-note">Describe an original voice, not a real person's.</p>
    <label className="voice-design-share"><input type="checkbox" checked={share} disabled={busy} onChange={(e) => { setShare(e.target.checked); setAudition(undefined); }}/>Include this voice when exporting the read</label>
    <div className="voice-design-audition">
      <button className="button" disabled={busy || !description.trim()} onClick={() => void generate()}>{busy ? "Working…" : audition ? "Regenerate" : "Generate audition"}</button>
      {url && <audio aria-label="Designed voice audition" controls src={url}/>}
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="modal-actions"><button className="button" onClick={close}>{busy ? "Cancel generation" : "Discard"}</button><button className="button primary" disabled={busy || !audition} onClick={() => void keep()}>Keep voice</button></div>
  </div>;
}
