// Controls for keeping a table read beside an FDX or Fountain file, and for moving one between writers as a
// single portable bundle. The review dialog is shared by sidecars and bundles: the writer chooses each destination.
import { useState } from "react";

import { CHANNELS, type OpenedFile } from "../../../shared/api.ts";
import { TABLE_READ, type ShareableReference } from "../../../shared/channels/table-read.ts";
import { app, type ModalProps } from "../../core/app.ts";
import { useSession } from "../../core/hooks.ts";
import { desktop } from "../../core/platform.ts";
import type { DocumentSession } from "../../core/session.ts";
import {
  BUNDLE_EXTENSION, BUNDLE_IMPORT_EXTENSIONS, bytesToBase64, createBundle, MAX_BUNDLE_BYTES, MAX_RENDERED_BYTES, parseBundle,
  type BundleAudio, type BundleRestoreProps,
} from "./bundle.ts";
import { completeBundleImport, importBundle } from "./bundle-files.ts";
import { readStoredCast } from "./cast-store.ts";
import {
  readTableReadSidecar, sidecarMode, tableReadScriptFormat, writeTableReadSidecar,
} from "./sidecar-files.ts";
import { applySidecar, buildSidecar, duplicateDestination, hasTableReadData, reviewedMatch, type ApplyResult, type RestoreProps } from "./sidecar.ts";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function isWave(bytes: Uint8Array): boolean {
  return bytes.length > 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.subarray(8, 12)) === "WAVE";
}

function voiceIds(doc: DocumentSession["doc"]): string[] {
  const cast = readStoredCast(doc), ids = new Set<string>();
  for (const character of cast.characters) if (character.voices.qwen) ids.add(character.voices.qwen);
  if (cast.narrator.qwen) ids.add(cast.narrator.qwen);
  return [...ids];
}

export function RestoreReview({ props, close }: ModalProps<RestoreProps | BundleRestoreProps>) {
  const session = useSession();
  const [choices, setChoices] = useState<Record<string, string>>(() => Object.fromEntries(
    props.match.pairs.map((pair) => [pair.storedId, pair.currentId ?? ""]),
  ));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bundle = "bundle" in props ? props.bundle : null;
  const unresolved = props.match.pairs.filter((pair) => !pair.currentId).length;

  const attach = async () => {
    const current = app.session;
    if (current.id !== props.sessionId) return setError("The open script changed. Close this and reopen it.");
    if (current.readOnly) return setError("This script is read-only. Nothing can be attached.");
    const match = reviewedMatch(props.match, choices);
    const clash = duplicateDestination(match);
    if (clash) return setError(clash);
    setBusy(true); setError("");
    try {
      let result: ApplyResult | Awaited<ReturnType<typeof completeBundleImport>>;
      if (bundle) {
        result = await completeBundleImport(current, bundle, match);
        if ("referenceWarning" in result && result.referenceWarning) app.toast(result.referenceWarning, "info");
      } else {
        result = applySidecar(current, props.sidecar, match);
      }
      if (!result.applied) throw new Error(result.reason ?? "Nothing was attached.");
      const attached = [
        `${result.characters} character${result.characters === 1 ? "" : "s"}`,
        result.pronunciations ? `${result.pronunciations} pronunciation rule${result.pronunciations === 1 ? "" : "s"}` : "",
        result.notes ? `${result.notes} listening note${result.notes === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      const detached = result.detachedNotes
        ? ` ${result.detachedNotes} note${result.detachedNotes === 1 ? " was" : "s were"} kept detached. Reattach in Notes.`
        : "";
      app.toast(`Attached ${attached}.${detached}`, "success");
      close();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  return <div className="reader-restore">
    <p>{props.match.message}</p>
    {unresolved > 0 && <p className="reader-note">
      {unresolved} character{unresolved === 1 ? " has" : "s have"} no clear match. Leave them unattached unless you
      recognise the name.
    </p>}
    {props.match.pairs.length > 0 && <div className="reader-cast-list">{props.match.pairs.map((pair) =>
      <label key={pair.storedId} className="reader-cast-row">
        <strong>{pair.storedName}</strong>
        <span aria-hidden="true">→</span>
        <select aria-label={`Character for ${pair.storedName}`} value={choices[pair.storedId] ?? ""} disabled={busy}
          onChange={(event) => setChoices((old) => ({ ...old, [pair.storedId]: event.target.value }))}>
          <option value="">Don't attach</option>
          {props.match.current.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
        <small>{pair.reason}</small>
      </label>)}</div>}
    {props.sidecar.pronunciations.length > 0 && <p className="reader-note">
      {props.sidecar.pronunciations.length} pronunciation rule{props.sidecar.pronunciations.length === 1 ? "" : "s"} and
      {" "}{props.sidecar.notes.length} listening note{props.sidecar.notes.length === 1 ? "" : "s"} will be kept with
      the script.
    </p>}
    {bundle && bundle.references.length > 0 && <p className="reader-note">
      {bundle.references.length} shared reference voice{bundle.references.length === 1 ? "" : "s"} will be added to
      this Mac's voice bank.
    </p>}
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions">
      <button className="button" disabled={busy} onClick={close}>Don't attach</button>
      <button className="button primary" disabled={busy} onClick={() => void attach()}>Attach selected</button>
    </div>
  </div>;
}

export function ReaderPersistence({ session, writable }: { session: DocumentSession; writable: boolean }) {
  const format = tableReadScriptFormat(session);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [includeWave, setIncludeWave] = useState(false);
  const mode = session.path ? sidecarMode(session.path) : null;
  const hasData = hasTableReadData(session.doc);

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await task(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };

  const saveSidecar = () => run(async () => {
    if (!writable) throw new Error("This script is read-only.");
    if (!(await writeTableReadSidecar(session, { force: true }))) throw new Error("There is no table-read data to save yet.");
    app.toast("Saved the table-read file next to this script.", "success");
  });

  const exportBundle = () => run(async () => {
    const path = session.path;
    if (!path || !format) throw new Error("Open an FDX or Fountain script before exporting a table read.");
    const destination = await desktop.invoke<string | null>(CHANNELS.saveDialog, {
      title: "Export table read bundle", defaultPath: `${session.name}.${BUNDLE_EXTENSION}`,
      filters: [{ name: "Table read bundle", extensions: [BUNDLE_EXTENSION] }],
    });
    if (!destination) return;
    app.flushPending();
    const existing = await readTableReadSidecar(path).catch(() => null);
    const sidecar = buildSidecar(session, { projectId: existing?.projectId ?? crypto.randomUUID(), created: existing?.created });
    const ids = voiceIds(session.doc);
    const references = ids.length
      ? await desktop.invoke<ShareableReference[]>(TABLE_READ.shareableReferences, ids)
      : [];
    const rendered: BundleAudio[] = [];
    if (includeWave) {
      const files = await desktop.invoke<OpenedFile[]>(CHANNELS.openDialog, {
        title: "Choose a rendered WAV", filters: [{ name: "WAV audio", extensions: ["wav"] }],
      });
      const file = files?.[0];
      if (file) {
        if (file.data.length > MAX_RENDERED_BYTES) throw new Error("That WAV is larger than the bundle allows.");
        if (!isWave(file.data)) throw new Error("Choose a WAV file.");
        rendered.push({ name: file.name, mime: "audio/wav", audio: bytesToBase64(file.data) });
      }
    }
    const bundle = createBundle({ sidecar, references, rendered });
    await desktop.invoke(CHANNELS.writeFile, destination, JSON.stringify(bundle, null, 2));
    app.toast(`Exported ${destination.split("/").pop()}.`, "success");
  });

  const importFromFile = () => run(async () => {
    if (!writable) throw new Error("This script is read-only. A bundle cannot be attached.");
    const files = await desktop.invoke<OpenedFile[]>(CHANNELS.openDialog, {
      title: "Import table read bundle", filters: [{ name: "Table read bundle", extensions: BUNDLE_IMPORT_EXTENSIONS }],
    });
    const file = files?.[0];
    if (!file) return;
    if (file.data.length > MAX_BUNDLE_BYTES) throw new Error("That bundle is too large.");
    const outcome = await importBundle(session, parseBundle(file.data));
    if (outcome === "exact") app.toast("Attached the table read from the bundle.", "success");
  });

  if (!format) return null;
  return <section className="reader-persistence" aria-label="Table-read storage">
    <p className="reader-note">{mode === "sidecar"
      ? "This table read is saved beside the script as a versioned table-read file."
      : mode === "master"
        ? "You chose a .screenplay master. This FDX or Fountain file does not carry the table read."
        : "This file does not store the table read. Keep it beside the script or save a .screenplay master."}</p>
    <div className="reader-footer">
      <button className="button" disabled={busy || !writable || !hasData} onClick={() => void saveSidecar()}>
        {mode === "sidecar" ? "Update table-read file" : "Save table-read file next to this script"}
      </button>
      <button className="button" disabled={busy} onClick={() => void exportBundle()}>Export bundle…</button>
      <button className="button" disabled={busy || !writable} onClick={() => void importFromFile()}>Import bundle…</button>
      <label>
        <input type="checkbox" checked={includeWave} disabled={busy}
          onChange={(event) => setIncludeWave(event.target.checked)} />Include a rendered WAV
      </label>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
