// Installing a bundle's shareable reference voices and attaching its cast. Kept apart from bundle.ts so the
// format's validation stays testable without the renderer platform.
import { TABLE_READ } from "../../../shared/channels/table-read.ts";
import { app } from "../../core/app.ts";
import { desktop, isDesktop, messageBox } from "../../core/platform.ts";
import type { DocumentSession } from "../../core/session.ts";
import {
  matchSidecar, applySidecar,
  type SidecarMatch,
} from "./sidecar.ts";
import { tableReadScriptFormat } from "./sidecar-files.ts";
import type { BundleApplyResult, BundleRestoreProps, TableReadBundle } from "./bundle.ts";

/** Import the shareable reference voices, then attach the cast with voices pointed at their local IDs. */
export async function completeBundleImport(
  session: DocumentSession, bundle: TableReadBundle, match: SidecarMatch, confirmed?: ReadonlySet<string>,
): Promise<BundleApplyResult> {
  let voiceRemap: Record<string, string> = {}, warning = "";
  if (bundle.references.length) {
    try {
      voiceRemap = await desktop.invoke<Record<string, string>>(TABLE_READ.importReferences, bundle.references);
    } catch (error) {
      warning = `The reference voices were not installed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const result = applySidecar(session, bundle.project, match, confirmed, voiceRemap);
  return { ...result, references: Object.keys(voiceRemap).length, ...(warning ? { referenceWarning: warning } : {}) };
}

/**
 * Import a validated bundle into an open script. Exact matches attach after the writer chose the file; partial
 * matches open the same reviewed remapping as a sidecar; a mismatch attaches nothing.
 */
export async function importBundle(session: DocumentSession, bundle: TableReadBundle): Promise<"exact" | "partial" | "mismatch" | "skipped"> {
  if (session.readOnly) throw new Error("This script is read-only.");
  if (!isDesktop) throw new Error("Bundles need the desktop app.");
  const format = tableReadScriptFormat(session);
  if (!format) return "skipped";
  const match = matchSidecar(bundle.project, session.script(), format);
  if (match.kind === "exact") {
    const result = await completeBundleImport(session, bundle, match);
    if (result.referenceWarning) app.toast(result.referenceWarning, "info");
    return "exact";
  }
  if (match.kind === "partial") {
    app.openModal("tableRead.restore", { sessionId: session.id, sidecar: bundle.project, match, source: "bundle", bundle } satisfies BundleRestoreProps);
    return "partial";
  }
  await messageBox({
    type: "warning", message: "This table-read bundle does not match this script.",
    detail: "Nothing was attached and neither the script nor the bundle was changed.",
    buttons: ["Keep it"], defaultId: 0, cancelId: 0,
  });
  return "mismatch";
}
