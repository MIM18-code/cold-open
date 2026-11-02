// Reading, writing and restoring the table-read file beside an FDX or Fountain script. Kept apart from
// sidecar.ts so the matching and validation rules stay testable without the renderer platform.
import { TABLE_READ } from "../../../shared/channels/table-read.ts";
import { app } from "../../core/app.ts";
import { desktop, isDesktop, messageBox } from "../../core/platform.ts";
import type { DocumentSession } from "../../core/session.ts";
import {
  applySidecar, buildSidecar, hasTableReadData, matchSidecar, parseSidecar,
  type RestoreProps, type SidecarFormat, type TableReadSidecar,
} from "./sidecar.ts";

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export type SidecarMode = "sidecar" | "master";

export function sidecarMode(path: string): SidecarMode | null {
  const value = storage()?.getItem(`tableRead.sidecar.mode:${path}`);
  return value === "sidecar" || value === "master" ? value : null;
}

export function setSidecarMode(path: string, mode: SidecarMode): void {
  storage()?.setItem(`tableRead.sidecar.mode:${path}`, mode);
}

export function tableReadScriptFormat(session: DocumentSession): SidecarFormat | null {
  const path = session.path?.toLowerCase() ?? "";
  // A Fountain import from a .txt file is readable, but a sidecar name is only unambiguous for the exchange
  // file's own extension. Those scripts can still travel as a bundle once saved as .fountain.
  if (session.format === "fdx" && path.endsWith(".fdx")) return "fdx";
  if (session.format === "fountain" && path.endsWith(".fountain")) return "fountain";
  return null;
}

export async function readTableReadSidecar(path: string): Promise<TableReadSidecar | null> {
  if (!isDesktop) return null;
  const text = await desktop.invoke<string | null>(TABLE_READ.readSidecar, path);
  return text === null ? null : parseSidecar(JSON.parse(text));
}

/**
 * Offer the deliberate storage choice once per working file. Returns "master" when the writer chose a native
 * master, so the caller saves that instead of the exchange file. Declining still saves the exchange file.
 */
export async function chooseTableReadStorage(session: DocumentSession): Promise<"exchange" | "master"> {
  const path = session.path, format = tableReadScriptFormat(session);
  if (!isDesktop || !path || !format || session.readOnly) return "exchange";
  const store = storage();
  const offered = `tableRead.sidecar.offered:${path}`;
  if (sidecarMode(path) || store?.getItem(offered) || !hasTableReadData(session.doc)) return "exchange";
  store?.setItem(offered, "1");
  const choice = await messageBox({
    type: "question",
    message: "Where should the table read live?",
    detail: "Voice assignments, pronunciations and listening notes are not part of a Final Draft or Fountain file. "
      + "Save a .screenplay master to keep everything in one script file, or keep a table-read file next to this script. "
      + "You can change this later in Listen.",
    buttons: ["Save a .screenplay master…", "Keep a table-read file next to this script", "Not now"],
    defaultId: 1, cancelId: 2,
  });
  if (choice === 0) { setSidecarMode(path, "master"); return "master"; }
  if (choice === 1) setSidecarMode(path, "sidecar");
  return "exchange";
}

/**
 * Write the sidecar after a save. Only a deliberate sidecar choice writes automatically; `force` is the panel's
 * explicit action. Read-only sessions, native files and scripts without table-read data never write.
 */
export async function writeTableReadSidecar(session: DocumentSession, options: { force?: boolean } = {}): Promise<boolean> {
  const path = session.path, format = tableReadScriptFormat(session);
  if (!isDesktop || !path || !format || session.readOnly) return false;
  if (!options.force && sidecarMode(path) !== "sidecar") return false;
  const existing = await readTableReadSidecar(path).catch(() => null);
  // A sidecar that already exists is updated even when the writer has just removed the last cast row: leaving the
  // old file in place would restore data the writer deleted. Without either data or a file there is nothing to do.
  if (!hasTableReadData(session.doc) && !existing) return false;
  const sidecar = buildSidecar(session, {
    projectId: existing?.projectId ?? crypto.randomUUID(),
    created: existing?.created,
  });
  await desktop.invoke(TABLE_READ.writeSidecar, path, JSON.stringify(sidecar, null, 2));
  if (options.force) setSidecarMode(path, "sidecar");
  return true;
}

/** Restore, review or refuse. Never attaches across a mismatch; never writes in a read-only session. */
export async function restoreTableRead(
  session: DocumentSession, sidecar: TableReadSidecar, source: "sidecar" | "bundle",
): Promise<"exact" | "partial" | "mismatch" | "skipped"> {
  const format = tableReadScriptFormat(session);
  if (!format) return "skipped";
  const match = matchSidecar(sidecar, session.script(), format);
  if (match.kind === "exact") {
    if (session.readOnly) return "skipped";
    const wasClean = !session.dirty;
    const result = applySidecar(session, sidecar, match);
    // The sidecar already holds exactly what was attached, so opening it again should not ask to save the FDX.
    if (result.applied && wasClean && source === "sidecar" && session.path) {
      session.markSaved(session.path, session.format, session.name, session.version);
    }
    return "exact";
  }
  if (match.kind === "partial") {
    app.openModal("tableRead.restore", { sessionId: session.id, sidecar, match, source } satisfies RestoreProps);
    return "partial";
  }
  await messageBox({
    type: "warning",
    message: source === "bundle" ? "This table-read bundle does not match this script." : "This table-read file does not match this script.",
    detail: "Nothing was attached and neither file was changed. The cast, pronunciations and notes stay with the script they were made for.",
    buttons: ["Keep it"], defaultId: 0, cancelId: 0,
  });
  return "mismatch";
}

export async function restoreTableReadForOpen(session: DocumentSession): Promise<"exact" | "partial" | "mismatch" | "skipped"> {
  const path = session.path, format = tableReadScriptFormat(session);
  if (!isDesktop || !path || !format || session.readOnly) return "skipped";
  let sidecar: TableReadSidecar | null;
  try {
    sidecar = await readTableReadSidecar(path);
  } catch (error) {
    app.toast(`The table-read file next to this script could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
    return "skipped";
  }
  if (!sidecar) return "skipped";
  return restoreTableRead(session, sidecar, "sidecar");
}
