import { changeScriptNote, plainText, scriptNotes, type ScriptNoteInfo, type TextPosition } from "@screenplay/engine";
import { useMemo, useState } from "react";
import { app, type Feature, type ModalProps } from "../../core/app.ts";
import { useDocVersion, useSession } from "../../core/hooks.ts";
import { messageBox } from "../../core/platform.ts";
// The picker takes #rrggbb; Final Draft stores #rrrrggggbbbb, so show each channel's high byte.
const pickerColor = (color: string) => /^#[0-9a-f]{12}$/i.test(color) ? "#" + [1, 5, 9].map((i) => color.slice(i, i + 2)).join("") : /^#[0-9a-f]{6}$/i.test(color) ? color : "#ffff99";
function selection(): {
    from: TextPosition;
    to: TextPosition;
} | undefined {
    const value = app.editor?.getSelection();
    if (!value)
        return;
    const [from, to] = [value.anchor, value.head].sort((a, b) => app.session.doc.indexOf(a.paragraphId) - app.session.doc.indexOf(b.paragraphId) || a.offset - b.offset);
    return { from: from!, to: to! };
}
interface EditProps {
    sessionId: string;
    version: number;
    note?: ScriptNoteInfo;
    attach?: {
        from: TextPosition;
        to: TextPosition;
    };
}
function EditNote({ props, close }: ModalProps<EditProps>) {
    const [text, setText] = useState(props.note?.text ?? ""), [author, setAuthor] = useState(props.note?.author ?? ""), [color, setColor] = useState(props.note?.color ?? "#ffff99990000"), [error, setError] = useState("");
    const apply = () => {
        try {
            const session = app.session;
            if (session.id !== props.sessionId || session.version !== props.version)
                throw new Error("The draft changed. Close this preview and reopen the ScriptNote.");
            session.undo.stopCapturing();
            session.edit(() => changeScriptNote(session.doc, props.note?.key ?? null, { text, author, color }, props.attach));
            session.undo.stopCapturing();
            close();
        }
        catch (e) {
            setError(String(e));
        }
    };
    return <div className="roadmap-dialog"><p>Pinned to a passage in the script. It never prints, and it goes to Final Draft as a script note.</p>
    <label className="field"><span>Note text</span><textarea aria-label="Script note text" rows={7} maxLength={20000} value={text} onChange={(e) => setText(e.target.value)}/></label>
    <label className="field"><span>Author</span><input aria-label="Script note author" maxLength={160} value={author} onChange={(e) => setAuthor(e.target.value)}/></label>
    <label className="field"><span>Color</span><input type="color" aria-label="Script note color" value={pickerColor(color)} onChange={(e) => setColor(e.target.value)}/></label>
    {props.attach && <p>Pinned to: {plainText(app.session.doc.paragraph(props.attach.from.paragraphId).runs).slice(0, 160)}</p>}
    {error && <p role="alert">{error}</p>}<div className="dialog-actions"><button className="button" onClick={close}>Cancel</button><button className="button primary" disabled={!text.trim()} onClick={apply}>Save note</button></div>
  </div>;
}
function NotesPanel() {
    const session = useSession(), version = useDocVersion();
    const notes = useMemo(() => scriptNotes(session.doc), [session, version]);
    const [query, setQuery] = useState(""), [error, setError] = useState("");
    const edit = (note: ScriptNoteInfo, attach?: {
        from: TextPosition;
        to: TextPosition;
    }) => { app.flushPending(); app.openModal("fdxNotes.edit", { sessionId: session.id, version: session.version, note, attach }); };
    const remove = async (note: ScriptNoteInfo) => {
        const rev = session.version;
        const yes = await messageBox({ type: "question", message: "Remove this ScriptNote?", detail: note.text.slice(0, 200), buttons: ["Keep note", "Remove"], defaultId: 0, cancelId: 0 });
        if (yes !== 1)
            return;
        try {
            if (app.session !== session || session.version !== rev)
                throw new Error("The draft changed. Review the note again.");
            session.undo.stopCapturing();
            session.edit(() => changeScriptNote(session.doc, note.key, null));
            session.undo.stopCapturing();
        }
        catch (e) {
            setError(String(e));
        }
    };
    return <section className="roadmap-dialog" aria-label="Script notes"><h2>Script notes</h2><p>Notes pinned to passages in the script. They follow the text as you edit, never print, and go to Final Draft as script notes.</p>
    <input type="search" aria-label="Filter script notes" placeholder="Find note or author" value={query} onChange={(e) => setQuery(e.target.value)}/>
    <button className="button" disabled={session.readOnly} onClick={() => app.runCommand("fdxNotes.new")}>New at selection…</button>
    {error && <p role="alert">{error}</p>}
    {notes.filter((n) => `${n.title} ${n.text} ${n.author}`.toLowerCase().includes(query.toLowerCase())).map((note) => <article className="project-record" key={note.key}><strong>{note.title || note.author || "Note"}</strong>{note.title && note.author && <small>{note.author}</small>}<small>{note.state === "orphan" ? "Its passage was deleted. Reattach it before sending to Final Draft." : note.state === "unmapped" ? "Couldn't find the passage it was pinned to" : note.scope === "document" ? "Pinned to a passage" : "Pinned to a paragraph"}</small><p style={{ whiteSpace: "pre-wrap" }}>{note.text}</p>
      <div className="dialog-actions"><button className="button" disabled={!note.from} onClick={() => { if (!note.from)
            return; app.setView("script"); setTimeout(() => { app.editor?.revealParagraph(note.from!.paragraphId); app.editor?.setSelection(note.from!, note.to); }, 0); }}>Locate</button>
      <button className="button" disabled={session.readOnly || note.state === "orphan"} onClick={() => edit(note)}>Edit…</button>
      <button className="button" disabled={session.readOnly} onClick={() => { const at = selection(); if (!at)
            return setError("Select a passage in the script first."); edit(note, at); }}>Reattach to selection…</button>
      <button className="button" disabled={session.readOnly} onClick={() => void remove(note)}>Remove…</button></div>
    </article>)}{!notes.length && <p>No script notes yet. Select a passage and choose New at selection. Notes that aren't tied to the text, with replies, are in the Notes panel.</p>}
  </section>;
}
const feature: Feature = { id: "fdxNotes", panels: [{ id: "fdxNotes", title: "Script Notes", side: "right", order: 6, component: NotesPanel }], modals: [{ id: "fdxNotes.edit", title: "Script note", width: 650, component: EditNote }], commands: [
        { id: "fdxNotes.open", label: "Script Notes", menu: "Tools", group: "rewrite", run: () => { app.setFocusMode(false); app.togglePanel("fdxNotes", true); } },
        { id: "fdxNotes.new", label: "New Script Note…", menu: "Tools", group: "rewrite", enabled: () => !app.session.readOnly, run: () => { app.flushPending(); const attach = selection(); if (!attach) {
                app.toast("Put the caret in the screenplay or select a passage first.", "info");
                return;
            } app.openModal("fdxNotes.edit", { sessionId: app.session.id, version: app.session.version, attach }); } },
    ] };
export default feature;
