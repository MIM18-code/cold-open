// PDF export, printing, the print preview, the Printing settings, page breaks in the editor and the page count
// in the status bar. Pagination comes from the engine (Final Draft's rules); see options.ts and pages.ts.
import { assertUniqueSceneNumbers, revisionState, type PageLayout, type Script } from "@screenplay/engine";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { CHANNELS } from "../../../shared/api.ts";
import { PRINT_CHANNELS, type PrintRequest, type PrintResult } from "../../../shared/channels/print.ts";
import { app, type App, type Feature, type ModalProps } from "../../core/app.ts";
import { useApp, useEditor, useScript, useSetting } from "../../core/hooks.ts";
import { desktop, isDesktop, messageBox } from "../../core/platform.ts";
import { resolveSceneNumbersForDelivery } from "../revisions/settle.ts";
import { titlePageLines, valuesOf, titleFields } from "../title-page/titlepage.ts";
import { currentPagination, startLivePagination, usePagination } from "./live.ts";
import { SETTINGS, readPrintSettings } from "./options.ts";
import { drawPages, pageAt, pageSvg, printDocument, type PageDrawing } from "./pages.ts";
import { buildPdf, describeUnprintable, pdfCharacters, unprintable } from "./pdf.ts";
import "./print.css";

/**
 * Everything needed to print the open script with the current settings, its locked pages and its revisions.
 * `revisedOnly` belongs to one preview or export, never to the saved settings, so it can't linger.
 */
function printable(target: App, script: Script, revisedOnly = false) {
  const settings = readPrintSettings(target.settings);
  const doc = target.session.doc;
  const pagination = currentPagination(target, script);
  const titlePage = settings.titlePage ? titlePageLines(script, pagination.layout.page) : null;
  const drawings = drawPages(script, pagination, {
    sceneNumbers: settings.sceneNumbers, header: settings.header, titlePage,
    revisions: { state: revisionState(doc), marks: settings.revisionMarks, colors: settings.revisionColors, revisedOnly },
  });
  return { pagination, drawings, page: pagination.layout.page };
}

function documentInfo(target: App, script: Script) {
  const values = valuesOf(titleFields(script));
  const title = values.Title?.split("\n")[0] || target.session.name;
  return { title, ...(values.Author ? { author: values.Author.replace(/\n/g, ", ") } : {}) };
}

/**
 * The PDF's built-in Courier has only Western European characters (WinAnsi); anything else would come out as "?".
 * Say which characters and where, and let the writer choose. Resolves true to go ahead.
 */
async function confirmUnprintable(drawings: readonly PageDrawing[]): Promise<boolean> {
  const missing = unprintable(drawings, await pdfCharacters());
  if (!missing.length) return true;
  const choice = await messageBox({
    type: "warning",
    message: `The PDF can't show ${missing.length === 1 ? "1 character" : `${missing.length} characters`} in this script.`,
    detail: `${describeUnprintable(missing)} would print as "?". The PDF uses the built-in Courier font, which has no other alphabets yet. `
      + "To keep them, use Print… and choose Save as PDF.",
    buttons: ["Export Anyway", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return choice === 0;
}

async function exportPdf(target: App, revisedOnly = false): Promise<void> {
  target.flushPending();
  const session = target.session;
  resolveSceneNumbersForDelivery(session);
  const script = session.script();
  assertUniqueSceneNumbers(script);
  const { drawings, page } = printable(target, script, revisedOnly);
  const info = documentInfo(target, script);
  if (!drawings.length) throw new Error("No page has revisions to print.");
  const missingGlyphs = unprintable(drawings, await pdfCharacters());
  // pdf-lib draws left to right only, so right-to-left lines always go through system rendering.
  const rtlLines = drawings.some((drawing) => drawing.items.some((item) => item.rtl));
  const systemPdf = isDesktop && (missingGlyphs.length > 0 || rtlLines);
  if (systemPdf && missingGlyphs.length) {
    const choice = await messageBox({ type: "info", message: "Use system-font PDF rendering for this draft?", detail: `${describeUnprintable(missingGlyphs)} need fallback fonts. The fixed page layout is retained, but review non-Latin shaping and glyph coverage in the exported file.`, buttons: ["Use system fonts", "Cancel"], defaultId: 0, cancelId: 1 });
    if (choice !== 0) return;
  } else if (!(await confirmUnprintable(drawings))) return;
  const path = await desktop.invoke<string | null>(CHANNELS.saveDialog, {
    title: "Export PDF", defaultPath: `${session.name}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return;
  const bytes = systemPdf
    ? await desktop.invoke<Uint8Array>("print:pdf", { title: info.title, width: page.width, height: page.height, html: printDocument(drawings, page, info.title) })
    : await buildPdf(drawings, page, info);
  await desktop.invoke(CHANNELS.writeFile, path, bytes);
  target.toast(`Exported ${path.split("/").pop()}${revisedOnly ? " (revised pages only)" : ""}`, "success");
}

async function sendToPrinter(target: App, drawings: readonly PageDrawing[], page: PageLayout, script: Script): Promise<void> {
  if (!drawings.length) throw new Error("No page has revisions to print.");
  // The pages were laid out before this click; renumbering now would print numbers they do not carry.
  if (resolveSceneNumbersForDelivery(target.session)) throw new Error("Scene numbers changed. Check the preview, then print again.");
  assertUniqueSceneNumbers(target.session.script());
  const title = documentInfo(target, script).title;
  const html = printDocument(drawings, page, title);
  if (!isDesktop) {
    // In a browser, print the same pages from a hidden frame.
    const frame = document.createElement("iframe");
    frame.style.cssText = "position: fixed; width: 0; height: 0; border: 0";
    frame.srcdoc = html;
    frame.onload = () => {
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 1000);
    };
    document.body.append(frame);
    return;
  }
  const request: PrintRequest = { html, width: page.width, height: page.height, title };
  const result = await desktop.invoke<PrintResult>(PRINT_CHANNELS.print, request);
  if (result.testBytes !== undefined) target.toast(`Rendered ${drawings.length} pages for printing.`, "info");
  else if (result.printed) target.toast("Sent to the printer.", "success");
  else if (result.reason && result.reason !== "cancelled") target.toast(`Printing failed: ${result.reason}`, "error");
}

// ----- Print preview ---------------------------------------------------------------------------------------

function PreviewModal({ close }: ModalProps) {
  const script = useScript(0);
  const settings = useSettingsRecord();
  const session = useApp((a) => a.session);
  // Only for this preview and what it prints or saves; every new preview and File > Export PDF start with all pages.
  const [revisedOnly, setRevisedOnly] = useState(false);
  const { drawings, page, pagination } = useMemo(() => printable(app, script, revisedOnly), [script, settings, session, revisedOnly]);
  const [busy, setBusy] = useState(false);
  const pages = revisedOnly ? drawings.length : pagination.pages.length;
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      app.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="print-preview">
      <div className="print-toolbar">
        <span className="print-count">
          {revisedOnly && !pages ? "No revised pages" : `${pages} ${revisedOnly ? "revised " : ""}${pages === 1 ? "page" : "pages"}`}
          {drawings[0]?.key === "title" ? " and a title page" : ""}
        </span>
        <span className="print-spacer" />
        <label className="print-check">
          <input type="checkbox" checked={revisedOnly} onChange={(event) => setRevisedOnly(event.target.checked)} />
          <span>Revised pages only</span>
        </label>
        <button className="button" disabled={busy} onClick={() => void run(async () => (close(), await exportPdf(app, revisedOnly)))}>Save PDF…</button>
        <button className="button primary" disabled={busy} onClick={() => void run(() => sendToPrinter(app, drawings, page, script))}>Print…</button>
      </div>
      <div className="print-pages">
        {drawings.map((drawing) => (
          <div key={drawing.key} className={`print-page ${drawing.key === "title" ? "print-title" : ""}`} data-page={drawing.key}
            style={{ aspectRatio: `${page.width} / ${page.height}` }} dangerouslySetInnerHTML={{ __html: pageSvg(drawing, page) }} />
        ))}
      </div>
    </div>
  );
}

/** The settings object, re-read when any setting changes. */
function useSettingsRecord(): Record<string, unknown> {
  return useSyncExternalStore((onChange) => app.subscribe(onChange), () => app.settings);
}

// ----- Settings --------------------------------------------------------------------------------------------

function TriState({ label, setting, hint }: { label: string; setting: string; hint: string }) {
  const [value, setValue] = useSetting<boolean | null>(setting, null);
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value === null ? "file" : value ? "on" : "off"}
        onChange={(event) => setValue(event.target.value === "file" ? null : event.target.value === "on")}>
        <option value="file">{hint}</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  );
}

function PrintingSettings() {
  const [sides, setSides] = useSetting(SETTINGS.sceneNumbers, "both");
  const [header, setHeader] = useSetting(SETTINGS.header, "");
  const [titlePage, setTitlePage] = useSetting(SETTINGS.titlePage, true);
  const [paper, setPaper] = useSetting(SETTINGS.paper, "letter");
  const [marks, setMarks] = useSetting(SETTINGS.revisionMarks, true);
  const [colors, setColors] = useSetting(SETTINGS.revisionColors, false);
  return (
    <div className="print-settings">
      <label className="field">
        <span>Scene numbers</span>
        <select value={sides} onChange={(event) => setSides(event.target.value)}>
          <option value="both">Left and right</option>
          <option value="left">Left only</option>
          <option value="right">Right only</option>
          <option value="none">Don't print</option>
        </select>
      </label>
      <TriState label="Automatic (CONT'D)" setting={SETTINGS.autoContinueds} hint="As the script is set (on for new scripts)" />
      <TriState label="(MORE) and (CONT'D) at page breaks" setting={SETTINGS.dialogueBreaks} hint="As the script is set (on for new scripts)" />
      <label className="field">
        <span>Header text</span>
        <input value={header} placeholder="Printed at the top of every numbered page" onChange={(event) => setHeader(event.target.value)} />
      </label>
      <label className="field">
        <span>Paper</span>
        <select value={paper} onChange={(event) => setPaper(event.target.value)}>
          <option value="letter">US Letter</option>
          <option value="a4">A4</option>
        </select>
      </label>
      <label className="print-check">
        <input type="checkbox" checked={titlePage} onChange={(event) => setTitlePage(event.target.checked)} />
        <span>Print the title page</span>
      </label>
      <label className="print-check">
        <input type="checkbox" checked={marks} onChange={(event) => setMarks(event.target.checked)} />
        <span>Print revision marks in the margin</span>
      </label>
      <label className="print-check">
        <input type="checkbox" checked={colors} onChange={(event) => setColors(event.target.checked)} />
        <span>Print revised pages in their revision color</span>
      </label>
      <p className="print-settings-note">To print only the revised pages, use the check box in Print Preview. It applies to that printout only.</p>
    </div>
  );
}

// ----- Status bar ------------------------------------------------------------------------------------------

function PageStatus() {
  const pagination = usePagination();
  const editor = useEditor();
  // The caret's page, recomputed on selection changes but stored only when it differs: React skips the render on
  // most keystrokes, and a render while the editor has focus costs a scan of the whole editable text.
  const pageIndex = () => {
    if (!pagination || !editor) return -1;
    const caret = editor.getSelection()?.head;
    if (caret) return pageAt(pagination, caret.paragraphId, caret.offset);
    const current = editor.currentParagraphId();
    return current ? pageAt(pagination, current) : -1;
  };
  const [index, setIndex] = useState(pageIndex);
  useEffect(() => {
    setIndex(pageIndex());
    return editor?.onSelectionChange(() => setIndex(pageIndex()));
  }, [editor, pagination]);
  if (!pagination) return null;
  const total = pagination.pages.length;
  return (
    <span className="print-status" title={`${total} ${total === 1 ? "page" : "pages"}`}>
      {index >= 0 && pagination.pages[index] ? `Page ${pagination.pages[index]!.number} of ${total}` : `${total} ${total === 1 ? "page" : "pages"}`}
    </span>
  );
}

const feature: Feature = {
  id: "print",
  commands: [
    { id: "print.exportPdf", label: "Export PDF…", menu: "File", group: "export", accelerator: "CmdOrCtrl+Shift+E", run: (a) => exportPdf(a) },
    { id: "print.print", label: "Print…", menu: "File", group: "print", accelerator: "CmdOrCtrl+P",
      run: (a) => (a.flushPending(), a.openModal("print.preview")) },
  ],
  modals: [{ id: "print.preview", title: "Print Preview", width: "wide", component: PreviewModal }],
  settings: [{ id: "printing", title: "Printing", order: 40, component: PrintingSettings }],
  status: [{ id: "print.pages", order: 90, component: PageStatus }],
  activate: (a) => startLivePagination(a),
};

export default feature;
