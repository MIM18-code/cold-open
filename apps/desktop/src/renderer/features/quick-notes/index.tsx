// Quick note capture (a small floating box that saves as you type, with a microphone) and the "Since last time"
// tray that lists notes which arrived while the writer was away. Both float above the window, outside the
// side panels, so neither moves the page.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { app, type Feature } from "../../core/app.ts";
import { useApp, useSessionState } from "../../core/hooks.ts";
import type { ProjectRecord } from "../rewrite/records.ts";
import { MicIcon } from "../dictation/Panel.tsx";
import { abandonQuickNote, closeQuickNote, flushQuickNote, setQuickCaret, setQuickText, toggleQuickMic, useQuickNote } from "./box.ts";
import { isPhoneNote, relativeTime } from "./since.ts";
import { bindSession, closeTray, dismissNote, openTray, pinNote, resolveNote, saveSeen, unbind, useTray } from "./tray.ts";
import "./quick-notes.css";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function QuickNoteBox() {
  const box = useQuickNote();
  // Brainstorm shows the same note in the page itself, so the floating copy stays hidden there.
  const inline = useApp((a) => a.ui.view === "brainstorm");
  const { readOnly } = useSessionState();
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (box.open && !inline) area.current?.focus();
  }, [box.open, box.focusTick, inline]);
  if (!box.open || inline) return null;
  const recording = box.mic === "recording", busy = box.mic === "working" || box.mic === "starting";
  const caret = (el: HTMLTextAreaElement): [number, number] => [el.selectionStart, el.selectionEnd];
  return <div className="quick-note" role="dialog" aria-modal="false" aria-label="Quick note">
    <div className="quick-note-head">
      <strong>New note</strong>
      <span className="quick-note-where" title={box.where}>{box.where}</span>
      <button className="icon-button" aria-label="Close quick note" title="Close (Esc)" onClick={() => void closeQuickNote()}>×</button>
    </div>
    <textarea ref={area} aria-label="Quick note text" rows={4} maxLength={20000} value={box.text} disabled={readOnly}
      placeholder="Type or dictate. It saves as you go."
      onChange={(e) => setQuickText(e.target.value, caret(e.currentTarget))}
      onSelect={(e) => setQuickCaret(caret(e.currentTarget))}
      onBlur={flushQuickNote}
      onKeyDown={(e) => {
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault(); e.stopPropagation(); void closeQuickNote();
        }
      }} />
    <div className="quick-note-foot">
      <button className={`button quick-note-mic ${recording ? "on" : ""}`} aria-pressed={recording} disabled={readOnly || busy}
        onMouseDown={(e) => e.preventDefault()} onClick={() => void toggleQuickMic()}
        title={recording ? "Stop and write down what you said" : "Dictate into this note"}>
        <MicIcon /><span>{recording ? `Stop ${clock(box.seconds)}` : "Dictate"}</span>
      </button>
      {recording && <div className="dictation-meter quick-note-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={box.level}>
        <div className="dictation-meter-fill" style={{ width: `${Math.round(box.level * 100)}%` }} />
      </div>}
      <span className="quick-note-hint">⌘↵ or Esc to finish</span>
      <button className="button" onClick={() => void closeQuickNote()}>Done</button>
    </div>
    <p className="quick-note-message" role="status">{readOnly ? "This script is read-only." : box.message}</p>
  </div>;
}

function TrayItem({ record, readOnly, now }: { record: ProjectRecord; readOnly: boolean; now: number }) {
  const [message, setMessage] = useState("");
  const act = (fn: (record: ProjectRecord) => void) => {
    try { fn(record); setMessage(""); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const phone = isPhoneNote(record), heading = record.title && record.title !== "Phone note" && record.title !== "Note" ? record.title : "";
  const why = readOnly ? "This script is read-only." : undefined;
  return <article className="since-item">
    <header>
      <span className={`since-author ${phone ? "phone" : ""}`}>{phone ? "Phone" : record.author || "Writer"}</span>
      <time dateTime={record.created} title={new Date(record.created).toLocaleString()}>{relativeTime(Date.parse(record.created), now)}</time>
      {record.anchor ? <span className="since-pinned">Pinned</span> : null}
    </header>
    {heading ? <h3>{heading}</h3> : null}
    <p>{record.text}</p>
    <div className="since-actions">
      <button className="button" disabled={readOnly} title={why} onClick={() => act(resolveNote)}>Resolve</button>
      <button className="button" disabled={readOnly || !app.editor} title={why} onClick={() => act(pinNote)}>Pin to passage</button>
      <button className="button" onClick={() => act(dismissNote)}>Dismiss</button>
    </div>
    {message ? <p className="since-message" role="alert">{message}</p> : null}
  </article>;
}

function SinceTray() {
  const tray = useTray();
  const { readOnly } = useSessionState();
  const rightPanel = useApp((a) => a.ui.rightPanel), focus = useApp((a) => !!a.ui.focusMode);
  const [now, setNow] = useState(() => Date.now());
  const [inset, setInset] = useState(16);
  useEffect(() => {
    if (!tray.open) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [tray.open]);
  // Stay beside the right side panel instead of covering it.
  useEffect(() => {
    if (!tray.open) return;
    const place = () => {
      const panel = document.querySelector<HTMLElement>(".sidepanel-right");
      setInset((panel && panel.offsetParent !== null ? panel.getBoundingClientRect().width : 0) + 16);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [tray.open, rightPanel, focus]);
  if (!tray.open) return null;
  const count = tray.items.length;
  return <aside className="since-tray" aria-label="Since last time" style={{ right: inset }}
    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeTray(); } }}>
    <div className="since-head">
      <h2>Since last time</h2>
      {count ? <span className="since-count">{count}</span> : null}
      <button className="icon-button" aria-label="Close Since last time" title="Close" onClick={closeTray}>×</button>
    </div>
    <button className="button since-new" disabled={readOnly} title={readOnly ? "This script is read-only." : "Start a note you can type or dictate"}
      onClick={() => void app.runCommand("rewrite.new.note")}>New note</button>
    <div className="since-list">
      {count ? tray.items.map((record) => <TrayItem key={record.id} record={record} readOnly={readOnly} now={now} />)
        : <p className="since-empty">Nothing new since you last worked on this script.</p>}
    </div>
  </aside>;
}

function Overlays() {
  return createPortal(<><QuickNoteBox /><SinceTray /></>, document.body);
}

function NewNotesStatus() {
  const { unseen, open } = useTray();
  if (open || !unseen) return null;
  return <button title="Show the notes that arrived while you were writing" onClick={openTray}>{unseen} new {unseen === 1 ? "note" : "notes"}</button>;
}

const feature: Feature = {
  id: "quick-notes",
  commands: [
    { id: "notes.since", label: "Notes Since Last Time", menu: "Tools", group: "rewrite", run: () => openTray() },
  ],
  toolbar: [{ id: "quick-notes.overlays", order: 999, component: Overlays }],
  status: [{ id: "quick-notes.new", order: 45, component: NewNotesStatus }],
  activate(a) {
    bindSession(a.session);
    const offSession = a.onSession((session) => {
      // The box belongs to the script it was started in; setSession has already written it there.
      abandonQuickNote();
      bindSession(session);
    });
    const leaving = () => { flushQuickNote(); saveSeen(); };
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", leaving);
    return () => {
      offSession();
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("beforeunload", leaving);
      unbind();
    };
  },
};

export default feature;
