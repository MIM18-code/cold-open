// The Dictate panel: the record button and meter, the proposal for the last take, and a box for text
// dictated somewhere else.
import { ELEMENT_LAYOUT, type ElementType } from "@screenplay/engine";
import { useMemo, useState, type KeyboardEvent } from "react";

import { SETTING_DEFAULTS, SETTING_KEYS, type ProposedElement, type TakeResult } from "../../../shared/channels/dictation.ts";
import { useScript, useSessionState, useSetting } from "../../core/hooks.ts";
import { messageBox } from "../../core/platform.ts";
import { formatAccelerator } from "../../shell/Shell.tsx";
import {
  acceptSuggestion, discardTake, formatText, ignoreSuggestion, insertTake, keepCommandsAsText, pushStart, pushStop, retryAudio, setEditing,
  setScope, toggleRecording, caretParagraph, unresolved,
} from "./controller.ts";
import { findMatches } from "./edits.ts";
import { store, useDictation, type Suggestion } from "./store.ts";

export const SHORTCUT = "CmdOrCtrl+Shift+D";

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="1" width="5" height="9" rx="2.5" fill="currentColor" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function Capture() {
  const { phase, level, seconds: elapsed } = useDictation();
  const [mode] = useSetting(SETTING_KEYS.mode, SETTING_DEFAULTS.mode);
  const recording = phase === "recording";
  const busy = phase === "working";
  const push = mode === "push";
  const label = recording ? (push ? "Release to stop" : "Stop") : push ? "Hold to talk" : "Start dictation";
  const space = (event: KeyboardEvent, down: boolean) => {
    if (!push || event.key !== " " || event.repeat) return;
    event.preventDefault();
    void (down ? pushStart() : pushStop());
  };
  return (
    <section className="dictation-capture">
      <button className={`dictation-mic ${recording ? "on" : ""}`} disabled={busy} aria-pressed={recording}
        onClick={push ? undefined : () => void toggleRecording()}
        onPointerDown={push ? () => void pushStart() : undefined}
        onPointerUp={push ? () => void pushStop() : undefined}
        onPointerLeave={push && recording ? () => void pushStop() : undefined}
        onKeyDown={(event) => space(event, true)} onKeyUp={(event) => space(event, false)}>
        <MicIcon /> {label}
      </button>
      <div className="dictation-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
        <div className="dictation-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      <div className="dictation-hint">
        {recording ? `Listening ${clock(elapsed)}`
          : push ? `Hold the button while you talk. ${formatAccelerator(SHORTCUT)} also starts and stops.`
            : `Press ${formatAccelerator(SHORTCUT)} to start and stop. Talk the scene in order; no commands needed.`}
      </div>
      <p className="dictation-hint">Dictation continues at the end of your script. Highlight text first to replace it with a reviewed take. For Wispr Flow, choose Continue at end, dictate into the page, then press {formatAccelerator("CmdOrCtrl+Shift+Enter")} to format.</p>
    </section>
  );
}

function ElementPreview({ element, flagged }: { element: ProposedElement; flagged: string }) {
  const layout = ELEMENT_LAYOUT[element.type as ElementType];
  const width = 6;
  const style = {
    marginLeft: `${((layout.left - 1.5) / width) * 100}%`,
    marginRight: `${((7.5 - layout.right) / width) * 100}%`,
    textAlign: layout.align,
    textTransform: layout.caps ? ("uppercase" as const) : undefined,
    fontStyle: layout.italic ? "italic" : undefined,
  };
  return (
    <div className={`dictation-el dictation-el-${element.type} ${flagged ? "flagged" : ""}`} style={style} title={flagged || undefined}>
      {element.text}
    </div>
  );
}

function Transcript({ take, editing, editText }: { take: TakeResult; editing: boolean; editText: string }) {
  return (
    <section className="dictation-block">
      <div className="dictation-label">{take.source === "audio" ? "Heard" : "Text"}</div>
      {editing ? (
        <>
          <textarea className="dictation-textarea" aria-label="Transcript" value={editText} rows={5}
            onChange={(event) => store.set({ editText: event.target.value })} />
          <div className="dictation-row">
            <button className="button primary" disabled={!editText.trim()} onClick={() => void formatText(editText)}>Re-format</button>
            <button className="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p className="dictation-transcript">{take.transcript}</p>
          <div className="dictation-row">
            <button className="button" onClick={() => setEditing(true)}>Edit transcript</button>
          </div>
        </>
      )}
    </section>
  );
}

function Timings({ take }: { take: TakeResult }) {
  const { transcribeMs, formatMs } = take.timings;
  const parts = [
    take.source === "audio" && take.audioSeconds ? `${take.audioSeconds.toFixed(1)} s of audio` : "",
    take.source === "audio" ? `transcribed in ${seconds(transcribeMs)}` : "",
    formatMs ? `formatted in ${seconds(formatMs)}` : "",
  ].filter(Boolean);
  return parts.length ? <div className="dictation-hint">{parts.join(", ")}</div> : null;
}

function SuggestionCard({ suggestion, index }: { suggestion: Suggestion; index: number }) {
  const script = useScript(150);
  const { command, status, scope } = suggestion;
  const matches = useMemo(() => findMatches(script, { ...command, scope }, caretParagraph()), [script, command, scope]);
  const { readOnly } = useSessionState();
  if (status !== "pending") {
    return <div className="dictation-suggestion done">{status === "accepted" ? "Changed" : "Ignored"}: {command.find} to {command.replacement}</div>;
  }
  return (
    <div className="dictation-suggestion">
      <div className="dictation-suggestion-title">Change “{command.find}” to “{command.replacement}”</div>
      <div className="dictation-hint">You said: {command.spoken}</div>
      <label className="dictation-inline">
        <span>Where</span>
        <select value={scope} onChange={(event) => setScope(index, event.target.value as "script" | "scene")}>
          <option value="script">Everywhere in the script</option>
          <option value="scene">This scene only</option>
        </select>
      </label>
      <div className="dictation-hint">{matches.length ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : "No matches in the script."}</div>
      <ul className="dictation-matches">
        {matches.slice(0, 5).map((match, i) => (
          <li key={i}>
            <span className="dictation-context">{match.before}</span><del>{match.matched}</del><ins>{match.replacement}</ins>
            <span className="dictation-context">{match.after}</span>
          </li>
        ))}
        {matches.length > 5 ? <li className="dictation-hint">and {matches.length - 5} more</li> : null}
      </ul>
      <div className="dictation-row">
        <button className="button primary" disabled={!matches.length || readOnly} onClick={() => acceptSuggestion(index)}>Accept</button>
        <button className="button" onClick={() => ignoreSuggestion(index)}>Ignore</button>
      </div>
    </div>
  );
}

function Review() {
  const { take, inserted, editing, editText, suggestions, replacing, selectedText } = useDictation();
  // A read-only co-writing session: the take can be read and discarded, never inserted.
  const { readOnly } = useSessionState();
  if (!take) return null;
  const discard = async () => {
    if (!inserted) {
      const response = await messageBox({ type: "warning", message: "Discard this take?", detail: "The transcript and proposed script have not been inserted and will be lost.", buttons: ["Keep", "Discard"], defaultId: 0, cancelId: 0 });
      if (response !== 1) return;
    }
    discardTake();
  };
  const flags = new Map<number, string[]>();
  for (const d of take.diagnostics) if (d.elementIndex !== null) flags.set(d.elementIndex, [...(flags.get(d.elementIndex) ?? []), d.message]);
  take.elements.forEach((element, i) => element.uncertainty && flags.set(i, [...(flags.get(i) ?? []), element.uncertainty]));
  const notes = [...take.diagnostics.map((d) => ({ severity: d.severity, message: d.message })), ...take.warnings.map((message) => ({ severity: "warning" as const, message }))];
  const count = take.elements.length;
  return (
    <div className="dictation-review">
      <Transcript take={take} editing={editing} editText={editText} />
      <Timings take={take} />
      {take.error ? <div className="dictation-error" role="alert">{take.error} Your transcript is kept. Edit it or format it again.</div> : null}
      {notes.length ? (
        <section className="dictation-block">
          <div className="dictation-label">Check before inserting</div>
          <ul className="dictation-notes">
            {notes.map((note, i) => <li key={i} className={`dictation-note-${note.severity}`}>{note.message}</li>)}
          </ul>
        </section>
      ) : null}
      {count ? (
        <section className="dictation-block">
          <div className="dictation-label">Proposed script</div>
          <p className="dictation-hint">{replacing ? "Replaces only the text you highlighted before this take. Review the transcript and formatted text before applying." : "Adds to the end of your script."}</p>
          {replacing ? <details><summary>Original selected text</summary><p className="dictation-transcript">{selectedText}</p></details> : null}
          <div className="dictation-script">
            {take.elements.map((element, i) => <ElementPreview key={i} element={element} flagged={(flags.get(i) ?? []).join(" ")} />)}
          </div>
          <div className="dictation-row">
            {inserted ? <span className="dictation-hint">Inserted.</span>
              : <button className="button primary" disabled={readOnly} title={readOnly ? "This script is read-only." : undefined} onClick={insertTake}>
                {replacing ? "Replace selected text" : `Insert ${count} element${count === 1 ? "" : "s"}`}</button>}
            <button className="button" onClick={() => void discard()}>{inserted ? "Done" : "Discard"}</button>
          </div>
        </section>
      ) : null}
      {suggestions.length ? (
        <section className="dictation-block">
          <div className="dictation-label">Suggested edits</div>
          {suggestions.map((s, i) => <SuggestionCard key={i} suggestion={s} index={i} />)}
          {suggestions.some((s) => s.status === "pending") ? (
            <button className="button" disabled={readOnly} onClick={() => void keepCommandsAsText()}>Use as script text instead</button>
          ) : null}
        </section>
      ) : null}
      {!count && !suggestions.length && !take.error ? (
        <div className="dictation-row"><button className="button" onClick={() => void discard()}>Discard</button></div>
      ) : null}
    </div>
  );
}

function TextBox() {
  const { draft, phase } = useDictation();
  const pending = unresolved();
  return (
    <section className="dictation-block">
      <div className="dictation-label">Paste or type a transcript</div>
      <textarea className="dictation-textarea" aria-label="Transcript to format" rows={4} value={draft}
        placeholder="Text from Wispr Flow or another dictation app goes through the same formatting."
        onChange={(event) => store.set({ draft: event.target.value })} />
      <div className="dictation-row">
        <button className="button" disabled={!draft.trim() || pending || phase === "working" || phase === "recording"} onClick={() => void formatText(draft)}>
          Format
        </button>
      </div>
      {pending ? <p className="dictation-hint">Insert or discard the current take before formatting another. Your next transcript stays here.</p> : null}
    </section>
  );
}

export function DictationPanel() {
  const { phase, stage, error, retryable } = useDictation();
  return (
    <div className="dictation">
      <Capture />
      {phase === "working" ? <div className="dictation-working" role="status">{stage}…</div> : null}
      {error ? (
        <div className="dictation-error" role="alert">
          {error}
          {retryable ? <div className="dictation-row"><button className="button" onClick={() => void retryAudio()}>Try again</button></div> : null}
          {retryable ? <button className="button" onClick={async () => {
            const response = await messageBox({ type: "warning", message: "Discard this recording?", detail: "The audio has not been transcribed and cannot be tried again.", buttons: ["Keep", "Discard"], defaultId: 0, cancelId: 0 });
            if (response === 1) discardTake();
          }}>Discard recording</button> : null}
        </div>
      ) : null}
      <Review />
      <TextBox />
    </div>
  );
}
