import { plainText } from "@screenplay/engine";
import { useMemo, useState } from "react";
import { app, type Feature, type ModalProps } from "../../core/app.ts";
import type { DocumentSession } from "../../core/session.ts";
import type { Selection } from "../../core/editor-bridge.ts";
import { desktop, isDesktop } from "../../core/platform.ts";
import { inOtherTextField } from "../../core/keyboard.ts";
import { applyPaste, pageFurniture, preparePaste, screenplayPaste, type PasteMode } from "./model.ts";
interface Captured {
    session: DocumentSession;
    version: number;
    selection: Selection;
    text: string;
    mode: PasteMode;
}
async function open(mode: PasteMode, preview: boolean): Promise<void> {
    app.flushPending();
    const session = app.session, version = session.version, selection = app.editor?.getSelection();
    if (!selection || session.readOnly)
        throw new Error("Place the caret in an editable screenplay first.");
    const text = isDesktop ? await desktop.invoke<string>("clipboard:read-text") : await navigator.clipboard.readText();
    if (app.session !== session || session.version !== version)
        throw new Error("The document changed while reading the clipboard. Paste again.");
    if (preview)
        app.openModal("paste.review", { session, version, selection, text, mode });
    else {
        applyPaste(session, version, selection, text, mode);
        app.editor?.focus();
    }
}
function PasteReview({ props, close }: ModalProps<Captured>) {
    const [mode, setMode] = useState(props.mode), [text, setText] = useState(props.text), [removed, setRemoved] = useState(new Set<number>()), [unwrap, setUnwrap] = useState(false), [error, setError] = useState("");
    const candidates = useMemo(() => pageFurniture(text), [text]);
    const result = useMemo(() => preparePaste(text, removed, unwrap), [text, removed, unwrap]);
    const paragraphs = useMemo(() => mode === "screenplay" ? screenplayPaste(result) : [], [mode, result]);
    const apply = () => {
        try {
            if (app.session !== props.session)
                throw new Error("The open document changed. Nothing was pasted.");
            const ids = applyPaste(props.session, props.version, props.selection, result, mode);
            close();
            app.editor?.focus();
            if (ids.at(-1))
                app.editor?.revealParagraph(ids.at(-1)!, { select: false });
        }
        catch (e) {
            setError(String(e));
        }
    };
    return <div className="roadmap-dialog"><p>Preview before insertion. No lines are discarded automatically. One Undo restores the original draft.</p>
    <label className="field"><span>Paste mode</span><select aria-label="Paste mode" value={mode} onChange={(e) => setMode(e.target.value as PasteMode)}><option value="screenplay">Interpret screenplay / Fountain elements</option><option value="plain">Literal text in the current element</option></select></label>
    <label className="field"><span>Clipboard text</span><textarea aria-label="Paste source" rows={8} maxLength={500000} value={text} onChange={(e) => { setText(e.target.value); setRemoved(new Set()); }}/></label>
    <details><summary>Review possible PDF page furniture ({candidates.length})</summary><p>These are guesses, including continuation labels that may be intentional. Check only the exact lines to remove.</p>{candidates.map((c) => <label className="roadmap-check" key={c.line}><input type="checkbox" checked={removed.has(c.line)} onChange={() => setRemoved((old) => { const next = new Set(old); next.has(c.line) ? next.delete(c.line) : next.add(c.line); return next; })}/>{c.reason} · line {c.line + 1}: {c.text || "[blank]"}</label>)}</details>
    <label><input type="checkbox" checked={unwrap} onChange={(e) => setUnwrap(e.target.checked)}/>Join indented lowercase continuation lines (review below)</label>
    <div aria-label="Paste preview" className="roadmap-preview">{mode === "plain" ? <pre>{result}</pre> : paragraphs.slice(0, 200).map((p, i) => <p key={i}><small>{p.type}</small> {plainText(p.runs)}</p>)}</div>
    <p>{removed.size} lines selected for removal. {mode === "screenplay" ? `${paragraphs.length} elements; first 200 shown.` : "Literal line breaks preserved inside the current element."}</p>
    {error && <p role="alert">{error}</p>}<div className="modal-actions"><button className="button" onClick={close}>Cancel</button><button className="button primary" onClick={apply}>Paste reviewed text</button></div>
  </div>;
}
const feature: Feature = { id: "smart-paste", modals: [{ id: "paste.review", title: "Smart Paste / PDF text cleanup", width: 850, component: PasteReview }], commands: [
        { id: "paste.plain", label: "Paste Literal Text", menu: "Edit", group: "paste-modes", enabled: () => !!app.editor && !app.session.readOnly && !inOtherTextField(), run: () => open("plain", false) },
        { id: "paste.screenplay", label: "Paste Screenplay with Preview…", menu: "Edit", group: "paste-modes", enabled: () => !!app.editor && !app.session.readOnly && !inOtherTextField(), run: () => open("screenplay", true) },
        { id: "paste.smart", label: "Smart Paste / Clean PDF Text…", menu: "Edit", group: "paste-modes", accelerator: "CmdOrCtrl+Alt+Shift+V", enabled: () => !!app.editor && !app.session.readOnly && !inOtherTextField(), run: () => open("screenplay", true) },
    ] };
export default feature;
