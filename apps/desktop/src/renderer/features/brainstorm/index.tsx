// Brainstorm: a page for loose ideas, reached from the button left of Write. Opening it puts the caret in a fresh
// note, so typing starts at once; Dictate is one button away and never starts by itself. It drives the same note box
// as the floating quick note (New Note, Cmd+Shift+M), so what is typed here is an ordinary project note and also
// shows in the Notes panel.
import { useEffect, useRef } from "react";
import { type Feature } from "../../core/app.ts";
import { useDocVersion, useSession, useSessionState } from "../../core/hooks.ts";
import { MicIcon } from "../dictation/Panel.tsx";
import { closeQuickNote, flushQuickNote, openQuickNote, quickNoteId, quickNoteState, setQuickCaret, setQuickText, toggleQuickMic, useQuickNote } from "../quick-notes/box.ts";
import { ProjectItem } from "../rewrite/index.tsx";
import { records } from "../rewrite/records.ts";
import "./brainstorm.css";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function BrainstormView() {
  useDocVersion();
  const session = useSession();
  const { readOnly } = useSessionState();
  const box = useQuickNote();
  const area = useRef<HTMLTextAreaElement>(null);
  // A quick note started on the script is finished on arrival, so the page always opens on a fresh one. Leaving the
  // page keeps the note (it is already saved) and closes the box, so it doesn't follow the writer to Write.
  useEffect(() => {
    if (quickNoteState().open) void closeQuickNote();
    return () => { void closeQuickNote(); };
  }, []);
  // Runs after the effect above, so a note it just finished is replaced. Keep a fresh note ready: on arrival, after Done, and after another script opens.
  useEffect(() => { if (!box.open && !readOnly) openQuickNote(); }, [box.open, readOnly, session]);
  useEffect(() => { if (box.open) area.current?.focus(); }, [box.open, box.focusTick]);
  const recording = box.mic === "recording", busy = box.mic === "working" || box.mic === "starting";
  const caret = (el: HTMLTextAreaElement): [number, number] => [el.selectionStart, el.selectionEnd];
  const typing = quickNoteId();
  const notes = records(session.doc, "note").filter((r) => !r.parentId && !r.resolved && r.id !== typing);
  return <section className="brainstorm" aria-label="Brainstorm">
    <div className="brainstorm-column">
      <div className="brainstorm-compose">
        <textarea ref={area} aria-label="New note" rows={6} maxLength={20000} value={box.open ? box.text : ""} disabled={readOnly || !box.open}
          placeholder="Type or dictate an idea. It saves as you go."
          onChange={(e) => setQuickText(e.target.value, caret(e.currentTarget))}
          onSelect={(e) => setQuickCaret(caret(e.currentTarget))}
          onBlur={flushQuickNote}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void closeQuickNote(); }
          }} />
        <div className="brainstorm-foot">
          <button className={`button quick-note-mic ${recording ? "on" : ""}`} aria-pressed={recording} disabled={readOnly || busy || !box.open}
            onMouseDown={(e) => e.preventDefault()} onClick={() => void toggleQuickMic()}
            title={recording ? "Stop and write down what you said" : "Dictate into this note"}>
            <MicIcon /><span>{recording ? `Stop ${clock(box.seconds)}` : "Dictate"}</span>
          </button>
          {recording && <div className="dictation-meter quick-note-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={box.level}>
            <div className="dictation-meter-fill" style={{ width: `${Math.round(box.level * 100)}%` }} />
          </div>}
          <span className="brainstorm-hint">⌘↵ finishes this note and starts another</span>
          <button className="button" disabled={readOnly || !box.open} onClick={() => void closeQuickNote()}>Done</button>
        </div>
        <p className="brainstorm-message" role="status">{readOnly ? "This script is read-only." : box.message}</p>
      </div>
      {notes.length > 0 && <h2 className="brainstorm-heading">Notes <span>{notes.length}</span></h2>}
      <div className="brainstorm-list">{notes.map((record) => <ProjectItem key={record.id} record={record} />)}</div>
    </div>
  </section>;
}

const feature: Feature = {
  id: "brainstorm",
  // A high order keeps the existing Ctrl+Cmd+number view shortcuts where they were; the title bar places it first.
  views: [{ id: "brainstorm", title: "Brainstorm", order: 50, component: BrainstormView }],
};

export default feature;
