// File > Title Page…: edit the title page fields. They are stored in the document meta (Fountain keys) and, for
// a script opened from FDX, written into Final Draft's TitlePage XML as well, so FDX export carries the edit.
import type { FdxDocumentExtras, TitleField } from "@screenplay/engine";
import { useState } from "react";

import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { useSessionState } from "../../core/hooks.ts";
import type { DocumentSession } from "../../core/session.ts";
import { FIELDS, fdxTitlePage, mergeFields, titleFields, valuesOf, withTitlePage, type TitleValues } from "./titlepage.ts";
import "./title-page.css";

/** Store title page fields as one undoable edit. */
export function saveTitlePage(session: DocumentSession, fields: TitleField[]): void {
  session.edit(() => {
    session.doc.meta.set("titlePage", fields);
    const fdx = session.doc.meta.get("fdx") as FdxDocumentExtras | undefined;
    if (fdx) session.doc.meta.set("fdx", withTitlePage(fdx, fields));
  });
}

function TitlePageModal({ close }: ModalProps) {
  const [opened] = useState(() => {
    const script = app.session.script();
    const fields = titleFields(script);
    const values = valuesOf(fields);
    // A new title page starts with the usual credit line.
    const initial = Object.values(values).some(Boolean) ? values : { ...values, Credit: "Written by" };
    return { session: app.session, fields, initial, finalDraft: !!fdxTitlePage(script) };
  });
  const [values, setValues] = useState<TitleValues>(opened.initial);
  const { readOnly } = useSessionState();
  const set = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const save = () => {
    // Saving unchanged fields would still replace a Final Draft title page with the generated layout.
    const changed = FIELDS.some((field) => (values[field.key] ?? "") !== (opened.initial[field.key] ?? ""));
    if (changed && !readOnly && opened.session === app.session) saveTitlePage(app.session, mergeFields(opened.fields, values));
    close();
  };
  return (
    <form className="title-page-form" onSubmit={(event) => (event.preventDefault(), save())}>
      <fieldset className="title-page-fields" disabled={readOnly}>
        {FIELDS.map((field) => (
          <label key={field.key} className="field">
            <span>{field.label}</span>
            {field.multiline
              ? <textarea name={field.key} rows={field.key === "Contact" ? 4 : 2} value={values[field.key] ?? ""} placeholder={field.placeholder}
                  onChange={(event) => set(field.key, event.target.value)} />
              : <input name={field.key} value={values[field.key] ?? ""} placeholder={field.placeholder}
                  autoFocus={field.key === "Title"} onChange={(event) => set(field.key, event.target.value)} />}
          </label>
        ))}
      </fieldset>
      <p className="title-page-note">
        {readOnly ? "This script is read-only, so the title page can't be changed." : opened.finalDraft
          ? "Saving a change replaces the Final Draft title page with the standard layout."
          : "The title is centered a third of the way down; the contact block prints at the bottom left and the draft date at the bottom right."}
      </p>
      <div className="modal-actions">
        <button type="button" className="button" onClick={close}>{readOnly ? "Close" : "Cancel"}</button>
        <button type="submit" className="button primary" disabled={readOnly}>Save</button>
      </div>
    </form>
  );
}

const feature: Feature = {
  id: "title-page",
  commands: [
    { id: "title-page.edit", label: "Title Page…", menu: "File", group: "print", run: (a) => a.openModal("title-page.edit") },
  ],
  modals: [{ id: "title-page.edit", title: "Title Page", width: 520, component: TitlePageModal }],
};

export default feature;
