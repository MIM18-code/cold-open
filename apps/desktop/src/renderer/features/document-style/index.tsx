import {
  applyDocumentTemplate, captureScriptNotes, ELEMENT_TYPES, FDX_STYLE_NAMES, TEMPLATE_IDS, TEMPLATE_NAMES, TEMPLATE_NOTES,
  pageLocks, readStyle, templateStyle, underlineEntrances, writeStyle, type DocumentStyle, type ElementType, type TemplateId,
} from "@screenplay/engine";
import { useEffect, useMemo, useState } from "react";

import { CHANNELS } from "../../../shared/api.ts";
import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { desktop, isDesktop, messageBox } from "../../core/platform.ts";
import { DocumentSession } from "../../core/session.ts";
import { paginateForPrint, readPrintSettings } from "../print/options.ts";

/** A number field that keeps what is typed and passes up only valid numbers. */
function NumField({ value, onValue, ...rest }: { value: number; onValue: (n: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText((t) => (t.trim() !== "" && Number(t) === value ? t : String(value))); }, [value]);
  return <input {...rest} type="number" value={text}
    onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); if (e.target.value.trim() !== "" && Number.isFinite(n)) onValue(n); }}
    onBlur={() => setText(String(value))} />;
}
const ELEMENT_FIELD_LABELS = { left: "Left indent", right: "Right indent", firstIndent: "First-line indent", spaceBefore: "Space before", spacing: "Line spacing" } as const;
const MARGIN_LABELS = { top: "Top", bottom: "Bottom", header: "Header", footer: "Footer" } as const;

function NewTemplateDialog({ close }: ModalProps) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const choose = async (id: TemplateId) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (app.session.pristine) {
        app.setSession(DocumentSession.untitled(id));
        close();
        return;
      }
      if (isDesktop) {
        // Another document stays open in this window; the new script gets its own.
        await desktop.invoke(CHANNELS.newWindow, undefined, "open", id);
        close();
        return;
      }
      const response = await messageBox({
        type: "warning", message: "Start a new script from this template?",
        detail: "The script open in this window will close. Save it first if you need it.",
        buttons: ["New script", "Cancel"], defaultId: 0, cancelId: 1,
      });
      if (response !== 0) return;
      app.setSession(DocumentSession.untitled(id));
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return <div className="roadmap-dialog">
    <p>A new script starts with the template’s page layout and act structure. Existing scripts keep their text and are reformatted from Format → Document Layout and Templates.</p>
    {error && <p role="alert">{error}</p>}
    <div className="file-choice-list">{TEMPLATE_IDS.map((id) => (
      <button type="button" key={id} className="list-row file-choice" disabled={busy} onClick={() => void choose(id)}>
        <strong>{TEMPLATE_NAMES[id]}</strong><span>{TEMPLATE_NOTES[id]}</span>
      </button>
    ))}</div>
    <div className="modal-actions"><button className="button" disabled={busy} onClick={close}>Cancel</button></div>
  </div>;
}

function StyleDialog({ close }: ModalProps) {
  const [session] = useState(app.session), [version] = useState(app.session.version), [source] = useState(() => app.session.script());
  const [style, setStyle] = useState<DocumentStyle>(() => readStyle(source)), [type, setType] = useState<ElementType>("action"), [error, setError] = useState("");
  const [template, setTemplate] = useState<TemplateId | "">(source.template ?? "");
  const [underline, setUnderline] = useState(false), [parenthesize, setParenthesize] = useState(false);
  const current = style.elements[type];
  const effectiveTemplate = template || source.template;
  const preview = useMemo(() => { try {
    const fdx = writeStyle(source, style);
    const candidate = { ...source, fdx, ...(effectiveTemplate ? { template: effectiveTemplate } : {}) };
    return { fdx, pages: paginateForPrint(candidate, readPrintSettings(app.settings)).pages.length, error: "" };
  }
  catch (e) {
    return { fdx: null, pages: 0, error: String(e) };
  } }, [source, style, effectiveTemplate]);
  const baseline = useMemo(() => paginateForPrint(source, readPrintSettings(app.settings)).pages.length, [source]);
  const update = (key: string, value: unknown) => setStyle({ ...style, elements: { ...style.elements, [type]: { ...current, [key]: value } } });
  const chooseTemplate = (value: TemplateId | "") => {
    setTemplate(value);
    setStyle(value ? templateStyle(value) : readStyle(source));
    setUnderline(value === "multiCamera");
    setParenthesize(value === "stage");
  };
  const apply = () => { try {
    if (app.session !== session || session.version !== version)
      throw new Error("The draft changed. Reopen the layout preview before applying.");
    if (pageLocks(session.doc)?.length)
      throw new Error("Unlock production pages before changing the document layout.");
    if (!preview.fdx)
      throw new Error(preview.error);
    session.undo.stopCapturing();
    session.edit(() => {
      if (template) {
        applyDocumentTemplate(session.doc, template, {
          style, underlineEntrances: underline, parenthesizeStageDirections: parenthesize,
        });
      } else {
        session.doc.meta.set("fdx", preview.fdx!);
      }
      captureScriptNotes(session.doc);
    });
    session.undo.stopCapturing();
    close();
  }
  catch (e) {
    setError(String(e));
  } };
  return <div className="roadmap-dialog"><p>These settings change actual screenplay layout, including PDF/FDX export. Screen zoom is separate. Imported paragraph-specific formatting still overrides element defaults.</p>
    <label className="field"><span>Starting template</span><select aria-label="Layout template" value={template} onChange={(e) => chooseTemplate(e.target.value as TemplateId | "")}><option value="">Keep the document’s existing layout</option>{TEMPLATE_IDS.map((id) => <option value={id} key={id}>{TEMPLATE_NAMES[id]}</option>)}</select></label>
    <p>{template ? TEMPLATE_NOTES[template] : "The document keeps its current element settings and page rules."}</p>
    {template === "multiCamera" && <label><input type="checkbox" aria-label="Underline entrances and exits" checked={underline} onChange={(e) => setUnderline(e.target.checked)}/>Underline character entrances and exits in action</label>}
    {template === "stage" && <label><input type="checkbox" aria-label="Parenthesize stage directions" checked={parenthesize} onChange={(e) => setParenthesize(e.target.checked)}/>Put action paragraphs in parentheses</label>}
    <p>Existing act breaks and text are not added or removed. Templates are editable starting points, not broadcaster- or theatre-certified delivery specifications.</p>
    <fieldset><legend>Page margins (inches)</legend><div className="roadmap-grid">{(["top", "bottom", "header", "footer"] as const).map((key) => <label key={key}>{MARGIN_LABELS[key]}<NumField aria-label={`Page ${key}`} min={0} max={3} step={0.05} value={style.page[key]} onValue={(n) => setStyle({ ...style, page: { ...style.page, [key]: n } })}/></label>)}</div></fieldset>
    <label className="field"><span>Element</span><select aria-label="Layout element" value={type} onChange={(e) => setType(e.target.value as ElementType)}>{ELEMENT_TYPES.filter((t) => !["section", "synopsis", "note"].includes(t)).map((t) => <option value={t} key={t}>{FDX_STYLE_NAMES[t]}</option>)}</select></label>
    <div className="roadmap-grid">{(["left", "right", "firstIndent", "spaceBefore", "spacing"] as const).map((key) => <label key={key}>{ELEMENT_FIELD_LABELS[key]}<NumField aria-label={`Element ${key}`} step={0.05} value={current[key] ?? (key === "spacing" ? 1 : 0)} onValue={(n) => update(key, n)}/></label>)}</div>
    <label>Alignment <select aria-label="Element alignment" value={current.align} onChange={(e) => update("align", e.target.value)}>{["left", "center", "right"].map((align) => <option key={align}>{align}</option>)}</select></label>
    <div className="roadmap-grid">{(["caps", "bold", "italic", "underline"] as const).map((key) => <label key={key}><input type="checkbox" checked={!!current[key]} onChange={(e) => update(key, e.target.checked)}/>{key}</label>)}</div>
    <label>After Return <select aria-label="Element return key" value={style.returns[type] ?? ""} onChange={(e) => setStyle({ ...style, returns: { ...style.returns, [type]: e.target.value as ElementType } })}><option value="" disabled>Application default</option>{ELEMENT_TYPES.map((t) => <option key={t} value={t}>{FDX_STYLE_NAMES[t]}</option>)}</select></label>
    <p role="status">{preview.error || `${baseline} source pages → ${preview.pages} proposed pages. Apply is one undoable edit.`}</p>{error && <p role="alert">{error}</p>}
    <div className="modal-actions"><button className="button" onClick={close}>Cancel</button><button className="button primary" disabled={!!preview.error || session.readOnly} onClick={apply}>Apply document layout</button></div>
  </div>;
}

const feature: Feature = {
  id: "document-style",
  commands: [
    { id: "template.new", label: "New from Template…", menu: "File", group: "new", run: (a) => { a.flushPending(); a.openModal("template.new"); } },
    { id: "layout.edit", label: "Document Layout and Templates…", menu: "Format", group: "layout", enabled: () => !app.session.readOnly, run: (a) => { a.flushPending(); a.openModal("layout.edit"); } },
    { id: "layout.underlineEntrances", label: "Underline Entrances", menu: "Format", group: "layout", enabled: () => !app.session.readOnly, run: (a) => {
      a.flushPending();
      let count = 0;
      // Its own undo step, apart from typing just before or after.
      a.session.undo.stopCapturing();
      a.session.edit(() => { count = underlineEntrances(a.session.doc); });
      a.session.undo.stopCapturing();
      a.toast(count ? `Underlined ${count} ${count === 1 ? "entrance or exit" : "entrances and exits"}.` : "No entrances or exits to underline.", "info");
    } },
  ],
  modals: [
    { id: "template.new", title: "New from Template", width: 620, component: NewTemplateDialog },
    { id: "layout.edit", title: "Document layout / template preview", width: 820, component: StyleDialog },
  ],
};
export default feature;
