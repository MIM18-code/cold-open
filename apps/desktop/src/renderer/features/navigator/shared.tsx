// Small editing widgets the three structure views share: text that writes to the script when you leave it,
// a synopsis box that grows with its text, and the scene color picker.
import { SCENE_COLORS } from "@screenplay/engine";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { app } from "../../core/app.ts";
import { useSession, useSessionState } from "../../core/hooks.ts";

import "./structure.css";

/**
 * A draft of a value that lives in the script. Edits stay local while the field has focus and are written when
 * focus leaves (and after a pause, if `pause` is set), so typing never fights the live refresh of the views.
 * Save, Export, Close and opening another document write a pending draft first (app.flushPending).
 * `base` is the text the document is known to hold: the value last shown, or what this field last wrote. The
 * value prop trails a write by the views' refresh delay, so it cannot be the baseline on its own.
 */
function useDraft(value: string, commit: (text: string) => void, pause = 0) {
  const session = useSession();
  const [draft, setDraft] = useState(value);
  const state = useRef({ focused: false, dirty: false, cancelled: false, draft: value, base: value, commit, session });
  state.current.commit = commit;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = () => {
    clearTimeout(timer.current);
    const s = state.current;
    // The field belongs to the document it was drawn for. A draft left over from another document is dropped.
    if (app.session !== s.session) s.dirty = false;
    if (s.dirty && !s.cancelled && s.draft !== s.base) {
      s.base = s.draft;
      s.commit(s.draft);
    }
    s.dirty = false;
  };
  // Revert and Open keep scene and section IDs, so React reuses this field for the new document: start over from
  // what that document holds.
  if (state.current.session !== session) {
    clearTimeout(timer.current);
    Object.assign(state.current, { session, dirty: false, cancelled: false, draft: value, base: value });
    if (draft !== value) setDraft(value);
  }
  useEffect(() => {
    state.current.base = value;
    if (!state.current.focused) {
      state.current.draft = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => {
    const off = app.onFlush(flush);
    return () => {
      off();
      flush();
    };
  }, []);

  return {
    draft,
    onChange(next: string) {
      state.current.draft = next;
      state.current.dirty = true;
      setDraft(next);
      if (pause) {
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, pause);
      }
    },
    onFocus() {
      state.current.focused = true;
      state.current.cancelled = false;
    },
    onBlur() {
      state.current.focused = false;
      const wrote = state.current.dirty && !state.current.cancelled && state.current.draft !== state.current.base;
      flush();
      if (!wrote) {
        // Nothing written: show what the document holds, which may have changed while the field had focus.
        state.current.draft = state.current.base;
        setDraft(state.current.base);
      }
    },
    cancel() {
      state.current.cancelled = true;
      state.current.dirty = false;
    },
  };
}

export function EditableText({ value, onCommit, label, placeholder, className, autoFocus }: {
  value: string;
  onCommit(text: string): void;
  label: string;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const field = useDraft(value, onCommit);
  const { readOnly } = useSessionState();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) {
      input.current?.focus();
      input.current?.select();
    }
  }, [autoFocus]);
  return (
    <input ref={input} className={`structure-text ${className ?? ""}`} value={field.draft} placeholder={readOnly ? "" : placeholder}
      aria-label={label} disabled={readOnly} spellCheck={false}
      onChange={(event) => field.onChange(event.target.value)} onFocus={field.onFocus} onBlur={field.onBlur}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") input.current?.blur();
        else if (event.key === "Escape") (field.cancel(), input.current?.blur());
      }} />
  );
}

/** A multi-line field that grows to fit its text. */
export function SynopsisField({ value, onCommit, label, className }: {
  value: string;
  onCommit(text: string): void;
  label: string;
  className?: string;
}) {
  const field = useDraft(value, onCommit, 600);
  const { readOnly } = useSessionState();
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [field.draft]);
  return (
    <textarea ref={area} className={`structure-synopsis ${className ?? ""}`} value={field.draft} rows={1} placeholder="Synopsis"
      aria-label={label} disabled={readOnly}
      onChange={(event) => field.onChange(event.target.value)} onFocus={field.onFocus} onBlur={field.onBlur}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") (field.cancel(), area.current?.blur());
      }} />
  );
}

/** The scene color: a swatch that opens Final Draft's palette. */
export function ColorButton({ color, onChange, label }: { color: string | undefined; onChange(color: string | null): void; label: string }) {
  const [open, setOpen] = useState(false);
  const { readOnly } = useSessionState();
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <span className="structure-color" ref={root}>
      <button className={`structure-swatch ${color ? "set" : ""}`} style={color ? { background: color } : undefined} aria-label={label}
        aria-haspopup="true" aria-expanded={open && !readOnly} title="Scene color" disabled={readOnly} onClick={() => setOpen(!open)} />
      {open && !readOnly ? (
        <span className="structure-palette" role="menu">
          {SCENE_COLORS.map((c) => (
            <button key={c.value} role="menuitem" className={`structure-swatch set ${c.value === color ? "on" : ""}`} style={{ background: c.value }}
              title={c.name} aria-label={c.name} onClick={() => (onChange(c.value), setOpen(false))} />
          ))}
          <button role="menuitem" className="structure-palette-none" onClick={() => (onChange(null), setOpen(false))}>None</button>
        </span>
      ) : null}
    </span>
  );
}

/** A reminder in the views of what a Final Draft file keeps of the structure. */
export function FdxNotice() {
  const { format } = useSessionState();
  if (format !== "fdx") return null;
  return (
    <p className="structure-notice">
      Final Draft files keep a scene's synopsis (as its index card summary) but not sections or other synopses, so Save leaves
      those out. Use Save As to keep them in a .screenplay file.
    </p>
  );
}

/** Says why the cards and outline can't be changed while the script is read-only. */
export function ReadOnlyNotice() {
  const { readOnly } = useSessionState();
  if (!readOnly) return null;
  return <p className="structure-notice structure-readonly" role="status">Read-only. You can follow this script but not change it.</p>;
}
