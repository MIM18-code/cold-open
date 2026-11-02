// Find and Replace: the bar's state, matches drawn through the editor's decorations, and replacing.
// Replace All is one session edit, so one Undo takes it back.
import { plainText, scenesOf } from "@screenplay/engine";
import * as Y from "yjs";
import { scopedMatches, type SearchScope, type SearchContext } from "./search-scope.ts";

import { app } from "../../core/app.ts";
import { findMatches, typedText, type Match } from "./rules.ts";

const SOURCE = "find";
/** Searching a long script on every keystroke costs more than a frame, so typing re-runs it after a pause. */
const REFRESH_DELAY = 150;

export interface FindState {
  open: boolean;
  replacing: boolean;
  query: string;
  replacement: string;
  matchCase: boolean;
  wholeWord: boolean;
  scope: SearchScope;
  character: string;
  matches: Match[];
  /** Index of the selected match, or -1. */
  current: number;
  /** Bumped to ask the bar to focus its search field. */
  focusRequest: number;
}

type Listener = () => void;

class Find {
  state: FindState = {
    open: false, replacing: false, query: "", replacement: "", matchCase: false, wholeWord: false, scope: "all", character: "", matches: [], current: -1, focusRequest: 0,
  };
  private context: SearchContext = {};
  private scopeSelection: { start: Y.RelativePosition; end: Y.RelativePosition; fromId: string; toId: string } | null = null;
  private readonly listeners = new Set<Listener>();
  private offChange: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<FindState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  show(replacing: boolean): void {
    // The selected text, when there is some in one paragraph, becomes the search.
    const selection = app.editor?.getSelection();
    if (!this.state.open) {
      const doc = app.session.doc, current = app.editor?.currentParagraphId();
      this.context = { sceneId: scenesOf(doc.paragraphs()).find((s) => !!current && s.paragraphIds.includes(current))?.sceneId };
      this.scopeSelection = null;
      if (selection && doc.has(selection.anchor.paragraphId) && doc.has(selection.head.paragraphId)) {
        const ends = [selection.anchor, selection.head].sort((a,b) => doc.bodyIndex(a) - doc.bodyIndex(b));
        this.scopeSelection = { start: Y.createRelativePositionFromTypeIndex(doc.body, doc.bodyIndex(ends[0]!), 1), end: Y.createRelativePositionFromTypeIndex(doc.body, doc.bodyIndex(ends[1]!), -1), fromId: ends[0]!.paragraphId, toId: ends[1]!.paragraphId };
      }
    }
    let query = this.state.query;
    if (selection && selection.anchor.paragraphId === selection.head.paragraphId && selection.anchor.offset !== selection.head.offset) {
      const doc = app.session.doc;
      const text = plainText(doc.paragraphs()[doc.indexOf(selection.anchor.paragraphId)]!.runs);
      query = text.slice(Math.min(selection.anchor.offset, selection.head.offset), Math.max(selection.anchor.offset, selection.head.offset));
    }
    this.set({ open: true, replacing: replacing || this.state.replacing, query, focusRequest: this.state.focusRequest + 1 });
    this.follow();
    this.refresh();
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.set({ open: false, matches: [], current: -1 });
    this.offChange?.();
    this.offChange = null;
    app.editor?.setDecorations(SOURCE, []);
    app.editor?.focus();
  }

  update(patch: Partial<Pick<FindState, "query" | "replacement" | "matchCase" | "wholeWord" | "replacing" | "scope" | "character">>): void {
    this.set(patch);
    this.refresh();
  }

  /** Re-run the search when the script changes while the bar is open. */
  private follow(): void {
    this.offChange?.();
    let session = app.session;
    const watch = () => session.onChange(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), REFRESH_DELAY);
    });
    let off = watch();
    const offSession = app.onSession((next) => {
      off();
      session = next;
      this.context = {}; this.scopeSelection = null; this.set({ scope: "all", current: -1 });
      off = watch();
      this.refresh();
    });
    this.offChange = () => (off(), offSession());
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.state.open) return;
    const doc = app.session.doc, paragraphs = doc.paragraphs();
    const context = { ...this.context, character: this.state.character };
    if (this.scopeSelection && doc.has(this.scopeSelection.fromId) && doc.has(this.scopeSelection.toId)) {
      const from = Y.createAbsolutePositionFromRelativePosition(this.scopeSelection.start, doc.ydoc);
      const to = Y.createAbsolutePositionFromRelativePosition(this.scopeSelection.end, doc.ydoc);
      if (from?.type === doc.body && to?.type === doc.body && from.index <= to.index) {
        context.from = doc.positionAt(from.index); context.to = doc.positionAt(to.index);
      }
    }
    const matches = scopedMatches(paragraphs, findMatches(paragraphs, this.state.query, this.state), this.state.scope, context);
    const current = this.state.current >= 0 && this.state.current < matches.length ? this.state.current : -1;
    this.set({ matches, current });
    this.draw();
  }

  private draw(): void {
    app.editor?.setDecorations(SOURCE, this.state.matches.map((match, i) => ({
      ...match, className: i === this.state.current ? "editor-find-current" : "editor-find-match",
    })));
  }

  /** Matches up to date with the script, when an edit is still waiting to be searched. */
  private settle(): void {
    if (this.timer !== undefined) this.refresh();
  }

  /** Select the next (or previous) match after the caret. */
  next(backward = false): void {
    if (!this.state.open) this.show(false);
    this.settle();
    const { matches } = this.state;
    if (!matches.length) return;
    const doc = app.session.doc;
    const selection = app.editor?.getSelection();
    let index: number;
    if (!selection) index = backward ? matches.length - 1 : 0;
    else {
      const at = (position: { paragraphId: string; offset: number }) => doc.has(position.paragraphId) ? doc.bodyIndex(position) : 0;
      const caret = backward ? Math.min(at(selection.anchor), at(selection.head)) : Math.max(at(selection.anchor), at(selection.head));
      const starts = matches.map((match) => doc.bodyIndex({ paragraphId: match.paragraphId, offset: match.from }));
      if (backward) {
        index = starts.findLastIndex((start) => start < caret);
        if (index < 0) index = matches.length - 1;
      } else {
        index = starts.findIndex((start) => start >= caret);
        if (index < 0) index = 0;
      }
    }
    this.select(index);
  }

  private select(index: number): void {
    const match = this.state.matches[index];
    if (!match) return;
    this.set({ current: index });
    this.draw();
    const editor = app.editor;
    if (!editor) return;
    editor.setSelection({ paragraphId: match.paragraphId, offset: match.from }, { paragraphId: match.paragraphId, offset: match.to });
    editor.revealParagraph(match.paragraphId);
  }

  /** Replace the selected match and move to the next one. */
  replace(): void {
    this.settle();
    const match = this.state.matches[this.state.current];
    if (!match) return this.next();
    const replacement = replacementFor(match);
    if (app.editor) app.editor.replaceText(match.paragraphId, match.from, match.to, replacement);
    else app.session.edit(() => replaceIn(match));
    const caret = { paragraphId: match.paragraphId, offset: match.from + replacement.length };
    app.editor?.setSelection(caret);
    this.set({ current: -1 });
    this.refresh();
    this.next();
  }

  /** Replace every match as one undoable edit. Returns how many were replaced. */
  replaceAll(): number {
    this.settle();
    const matches = [...this.state.matches];
    if (!matches.length) return 0;
    const session = app.session;
    session.undo.stopCapturing();
    // From the end backwards, so earlier offsets in a paragraph stay valid.
    session.edit(() => {
      for (const match of matches.reverse()) replaceIn(match);
    });
    session.undo.stopCapturing();
    this.refresh();
    app.toast(`Replaced ${matches.length} match${matches.length === 1 ? "" : "es"}.`, "success");
    return matches.length;
  }
}

/** The replacement as it is stored in the match's element: caps elements store uppercase, as typing does. */
function replacementFor(match: Match): string {
  const doc = app.session.doc;
  return typedText(doc.paragraphs()[doc.indexOf(match.paragraphId)]!.type, find.state.replacement);
}

function replaceIn(match: Match): void {
  app.session.doc.replaceText(match.paragraphId, match.from, match.to, replacementFor(match));
}

export const find = new Find();
