import { applyTag, removeTag, plainText, TAG_CATEGORIES, tagDefinitions } from "@screenplay/engine";
import { useState } from "react";
import { app, type Feature, type ModalProps } from "../../core/app.ts";
function TagDialog({ close }: ModalProps) {
    const [session] = useState(app.session), [version] = useState(app.session.version), [selection] = useState(() => app.editor?.getSelection());
    const [category, setCategory] = useState("Props"), [label, setLabel] = useState(() => { if (!selection || selection.anchor.paragraphId !== selection.head.paragraphId)
        return ""; const p = session.doc.paragraph(selection.anchor.paragraphId); return plainText(p.runs).slice(Math.min(selection.anchor.offset, selection.head.offset), Math.max(selection.anchor.offset, selection.head.offset)).slice(0, 200); });
    const [replace, setReplace] = useState(false), [error, setError] = useState("");
    const definitions = tagDefinitions(session.script()), categories = [...new Set([...TAG_CATEGORIES.map(c => c[0]), ...definitions.map(d => d.category).filter(c => c !== "Unresolved category")])];
    const change = (remove = false) => { try {
        if (!selection || app.session !== session || session.version !== version || session.readOnly)
            throw new Error("The selection or draft changed. Select the source text and reopen tagging.");
        session.undo.stopCapturing();
        session.edit(() => remove ? removeTag(session.doc, selection.anchor, selection.head) : applyTag(session.doc, selection.anchor, selection.head, category, label, replace));
        session.undo.stopCapturing();
        close();
    }
    catch (e) {
        setError(String(e));
    } };
    return <div className="roadmap-dialog"><p>Tag the selected screenplay text for production breakdown. Text and formatting stay intact. Definitions and source spans travel in Final Draft files.</p><label className="field"><span>Category</span><select aria-label="Breakdown category" value={category} onChange={e => setCategory(e.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</select></label><label className="field"><span>Element name</span><input aria-label="Breakdown element name" list="breakdown-existing" value={label} maxLength={200} onChange={e => setLabel(e.target.value)}/><datalist id="breakdown-existing">{definitions.filter(d => d.category === category).map(d => <option value={d.label} key={d.number}/>)}</datalist></label><label><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)}/>Replace other tags inside this selection</label><p>Removing a span leaves its definition available for reuse. No screenplay words are deleted. Use Reports → Tags to review occurrences.</p>{error && <p role="alert">{error}</p>}<div className="modal-actions"><button className="button" onClick={close}>Cancel</button><button className="button" onClick={() => change(true)}>Remove tags from selection</button><button className="button primary" onClick={() => change()}>Apply breakdown tag</button></div></div>;
}
const feature: Feature = { id: "breakdown-tags", commands: [{ id: "tags.selection", label: "Tag Selected Text…", menu: "Tools", group: "production", enabled: () => !app.session.readOnly, run: a => { a.flushPending(); a.openModal("tags.selection"); } }], modals: [{ id: "tags.selection", title: "Breakdown tagging", width: 620, component: TagDialog }] };
export default feature;
