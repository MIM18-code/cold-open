// One open document: the collaborative ScreenplayDoc, where it lives on disk, whether it has unsaved changes,
// and undo. Every local edit goes through edit() so undo tracks it and sync can tell local changes from remote.
import { type Script, type StructuralMoveConflict, strandedByMove, refreshStrandedMoves, strandedMoveRange, ScreenplayDoc, newId, resolveSceneNumberConflicts, sceneNumbersLocked, templateScript, type TemplateId } from "@screenplay/engine";
import * as Y from "yjs";

export type SourceFormat = "screenplay" | "fdx" | "fountain";

/** Transaction origin for edits made in this window. Remote sync updates use their own origins and are not undoable. */
export const LOCAL_ORIGIN = Symbol("local");

/** Transaction origin for the renumbering after a merge: synced to every co-writer, and not an edit Undo takes back. */
export const SCENE_NUMBERS_ORIGIN = Symbol("scene-numbers");

/** Thrown by DocumentSession.edit while the document is read-only (a read-only co-writing invite). */
export class ReadOnlyError extends Error {
  constructor() {
    super("This script is read-only.");
    this.name = "ReadOnlyError";
  }
}

type Listener = () => void;

export class DocumentSession {
  readonly id = newId();
  readonly doc: ScreenplayDoc;
  readonly undo: Y.UndoManager;
  /** Where the document was opened from or last saved to, and in which format. Null while untitled. */
  path: string | null;
  /** Fingerprint of the last version opened or saved at path. */
  fileHash: string | null = null;
  format: SourceFormat;
  name: string;
  dirty = false;
  /**
   * Local edits are refused: a read-only co-writing invite, where changes could never be shared. Remote updates
   * still apply. Change it with setReadOnly so onState listeners hear about it.
   */
  readOnly = false;
  /** Bumped on every document change; cheap to compare in React. */
  version = 0;
  /** The crash-recovery copy this document was restored from; removed once the document is saved or discarded. */
  recoveredFrom: string | null = null;
  moveConflicts: StructuralMoveConflict[] = [];
  private cachedScript?: { version: number; script: Script };
  private sceneNumbersTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<Listener>();

  constructor(doc: ScreenplayDoc, options: { path?: string | null; format?: SourceFormat; name?: string } = {}) {
    this.doc = doc;
    this.path = options.path ?? null;
    this.format = options.format ?? "screenplay";
    this.name = options.name ?? "Untitled";
    // Only edits made through edit() are undoable; updates from sync or files arrive with other origins.
    this.undo = new Y.UndoManager([doc.body, doc.meta], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 600 });
    doc.body.observe(this.observeMoves);
    doc.meta.observe(this.observeMoveKnowledge);
    doc.ydoc.on("update", (_update, origin) => {
      this.version++;
      if (!this.dirty) {
        this.dirty = true;
        this.emitState();
      }
      for (const listener of this.listeners) listener();
      // Two writers can add a scene in the same locked gap while apart, and both get 12A. Once their documents
      // meet, give the second one the next free number here, after the update settles.
      if (origin !== LOCAL_ORIGIN && origin !== SCENE_NUMBERS_ORIGIN) this.queueSceneNumberCheck();
    });
  }

  private observeMoves = (_event: Y.YTextEvent, transaction: Y.Transaction): void => {
    this.moveConflicts = refreshStrandedMoves(this.doc, this.moveConflicts, transaction);
    if (!transaction.local) {
      const detected = strandedByMove(this.doc, transaction);
      if (detected.length) this.moveConflicts = [...this.moveConflicts, ...detected];
    }
  };

  private observeMoveKnowledge = (_event: Y.YMapEvent<unknown>, transaction: Y.Transaction): void => {
    if (!(transaction.changed as Map<unknown, unknown>).has(this.doc.body)) {
      const detected = strandedByMove(this.doc, transaction);
      if (detected.length) this.moveConflicts = [...this.moveConflicts, ...detected];
    }
  };

  leaveMoveText(id: string): void {
    this.moveConflicts = this.moveConflicts.filter(conflict => conflict.id !== id);
    this.emitState();
  }

  moveTextSelection(conflict: StructuralMoveConflict) {
    if (!this.moveConflicts.includes(conflict)) return;
    const range = strandedMoveRange(this.doc, conflict);
    if (!range) return;
    const anchor = this.doc.positionAt(range.start), head = this.doc.positionAt(range.start + range.length);
    if (anchor && head) return { anchor, head };
  }

  /** A new script with one empty scene heading, or with a template's layout and starting act structure. */
  static untitled(template: TemplateId = "feature"): DocumentSession {
    const doc = new ScreenplayDoc();
    doc.load(template === "feature"
      ? { titlePage: [], paragraphs: [{ id: newId(), type: "sceneHeading", runs: [] }] }
      : templateScript(template));
    const session = new DocumentSession(doc);
    session.undo.clear();
    session.dirty = false;
    return session;
  }

  /** Run document changes as one undoable local edit. Throws ReadOnlyError while the document is read-only. */
  edit<T>(change: () => T): T {
    if (this.readOnly) throw new ReadOnlyError();
    let result!: T;
    this.doc.ydoc.transact(() => {
      result = change();
    }, LOCAL_ORIGIN);
    return result;
  }

  /** The plain script, rebuilt at most once per document change. */
  script(): Script {
    if (this.cachedScript?.version !== this.version) this.cachedScript = { version: this.version, script: this.doc.toScript() };
    return this.cachedScript.script;
  }

  /** Untitled and never edited: safe to replace with an opened file. */
  get pristine(): boolean {
    return !this.path && !this.dirty;
  }

  /**
   * Record a save of the document as it was at `version`. Changes that arrived while the file was being
   * written (typing, a co-writer) leave the document dirty.
   */
  markSaved(path: string, format: SourceFormat, name: string, version = this.version): void {
    this.path = path;
    this.format = format;
    this.name = name;
    this.dirty = this.version !== version;
    this.emitState();
  }

  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    // A read-only follower takes the writers' repairs instead of making its own.
    this.doc.setRepairs(!readOnly);
    this.emitState();
  }

  markDirty(): void {
    this.dirty = true;
    this.emitState();
  }

  /** Document content changed (local or remote). */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Repair missing and duplicate scene numbers after a merge, while numbers are locked. Deferred so a burst of
   * updates is looked at once. A read-only follower leaves it to the writers, whose renumbering is synced here.
   */
  private queueSceneNumberCheck(): void {
    if (this.sceneNumbersTimer !== undefined || this.readOnly) return;
    this.sceneNumbersTimer = setTimeout(() => {
      this.sceneNumbersTimer = undefined;
      if (this.readOnly || !sceneNumbersLocked(this.doc)) return;
      this.doc.ydoc.transact(() => resolveSceneNumberConflicts(this.doc), SCENE_NUMBERS_ORIGIN);
    }, 0);
  }

  /** Path, name, dirty or read-only flag changed. */
  onState(listener: Listener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private emitState(): void {
    for (const listener of this.stateListeners) listener();
  }

  destroy(): void {
    clearTimeout(this.sceneNumbersTimer);
    this.sceneNumbersTimer = undefined;
    this.doc.body.unobserve(this.observeMoves);
    this.doc.meta.unobserve(this.observeMoveKnowledge);
    this.moveConflicts = [];
    this.undo.destroy();
    this.listeners.clear();
    this.stateListeners.clear();
  }
}
