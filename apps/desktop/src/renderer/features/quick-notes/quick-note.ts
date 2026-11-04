// One quick note: created in the document on the first words, kept in step as the writer types, removed again if
// the box ends up empty. No Save step, so nothing the writer typed or said is lost by closing the box.
import type { Selection } from "../../core/editor-bridge.ts";
import type { DocumentSession } from "../../core/session.ts";
import { anchorAt, createRecord, putRecord, RECORD_PREFIX, type Anchor, type ProjectRecord } from "../rewrite/records.ts";

export const NOTE_LIMIT = 20000;

/**
 * Where a note belongs: the selection, else the line the caret is on, else nowhere. The caret may be anywhere in
 * the app, so a missing or stale paragraph gives an unattached note instead of an error.
 */
export function captureAnchor(session: DocumentSession, selection: Selection | null | undefined, paragraphId: string | null | undefined): Anchor | undefined {
  const doc = session.doc;
  const points = selection && doc.has(selection.anchor.paragraphId) && doc.has(selection.head.paragraphId)
    ? [selection.anchor, selection.head].sort((a, b) => doc.indexOf(a.paragraphId) - doc.indexOf(b.paragraphId) || a.offset - b.offset)
    : [];
  if (points.length === 2) return anchorAt(doc, points[0]!, points[1]!);
  const id = selection?.head.paragraphId ?? paragraphId;
  return id && doc.has(id) ? anchorAt(doc, { paragraphId: id, offset: 0 }) : undefined;
}

/** Add spoken words to the text at the caret, with a space between words and no stray gap at either end. */
export function insertSpoken(text: string, start: number, end: number, spoken: string): { text: string; caret: number } {
  const words = spoken.trim();
  if (!words) return { text, caret: end };
  const from = Math.max(0, Math.min(start, text.length)), to = Math.max(from, Math.min(end, text.length));
  const before = text.slice(0, from), after = text.slice(to);
  const lead = before && !/\s$/.test(before) ? " " : "", trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = lead + words + trail;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

export type SaveResult = "created" | "updated" | "removed" | "none";

export class QuickNote {
  readonly session: DocumentSession;
  private base: ProjectRecord | null = null;
  private saved = "";
  /** The revision this box last wrote, so a co-writer's edit in between is refused rather than overwritten. */
  private revision: string | undefined;
  private readonly author: string;
  private readonly anchor: Anchor | undefined;
  private readonly onCreate: (id: string) => void;

  constructor(session: DocumentSession, options: { author: string; anchor?: Anchor; onCreate?: (id: string) => void }) {
    this.session = session;
    this.author = options.author;
    this.anchor = options.anchor;
    this.onCreate = options.onCreate ?? (() => {});
  }

  get id(): string | null {
    return this.base?.id ?? null;
  }

  get exists(): boolean {
    return !!this.base && this.session.doc.meta.has(RECORD_PREFIX + this.base.id);
  }

  /**
   * Make the document match the text: blank text means no note, anything else creates it on the first call and
   * rewrites it after. Throws while the script is read-only.
   */
  save(text: string): SaveResult {
    const next = text.slice(0, NOTE_LIMIT).trimEnd();
    const { doc } = this.session;
    if (!next.trim()) {
      if (!this.base || !this.exists) return "none";
      this.session.undo.stopCapturing();
      this.session.edit(() => doc.meta.delete(RECORD_PREFIX + this.base!.id));
      this.session.undo.stopCapturing();
      this.saved = "";
      return "removed";
    }
    if (next === this.saved && this.exists) return "none";
    const first = !this.base;
    if (first) {
      this.base = createRecord("note", "", next, { author: this.author, ...(this.anchor ? { anchor: this.anchor } : {}) });
      // The first words open an undo step, so Undo takes the whole note back at once.
      this.session.undo.stopCapturing();
    }
    const current = doc.meta.get(RECORD_PREFIX + this.base!.id) as ProjectRecord | undefined;
    // Claimed before it is written, so observers of the document (the tray) already know it is the writer's own.
    if (first) this.onCreate(this.base!.id);
    try {
      this.session.edit(() => putRecord(doc, { ...(current ?? this.base!), text: next }, current ? this.revision : undefined));
    } catch (error) {
      if (first) this.base = null;
      throw error;
    }
    this.saved = next;
    this.revision = (doc.meta.get(RECORD_PREFIX + this.base!.id) as ProjectRecord | undefined)?.revision;
    return first || !current ? "created" : "updated";
  }

  /** The last write: trailing blank space goes, and the next edit starts a new undo step. */
  finish(text: string): SaveResult {
    const result = this.save(text);
    this.session.undo.stopCapturing();
    return result;
  }
}
