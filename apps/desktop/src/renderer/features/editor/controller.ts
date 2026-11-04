import { returnKeyFlow } from "@screenplay/engine";
// The script editor. ProseMirror draws the script and captures input, but the ScreenplayDoc (one Y.Text)
// is the source of truth: every keystroke becomes engine operations inside session.edit(), so undo and
// co-writing see them, and every change to the Y.Text, local, undo or remote, redraws only the paragraphs
// that changed. The caret is kept as a paragraph ID and offset, or as a Y.RelativePosition across a
// co-writer's edits. Input ProseMirror handles itself (composition, spelling fixes, word deletion, drag
// and drop) arrives as a transaction; its effect is diffed against the last drawing and replayed on the
// engine, so nothing reaches the document any other way.
import {
  MARKS, plainText, type ElementType, type Mark, type Marks, type Paragraph, type Run, type ScreenplayDoc, type TextPosition,
} from "@screenplay/engine";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { EditorState, Selection as PMSelection, TextSelection, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import * as Y from "yjs";

import { app, matchesAccelerator, type Command } from "../../core/app.ts";
import type {
  Decoration as Highlight, EditorBridge, GhostText, NewParagraph, PageBreakMark, Position, RemoteCursor, Selection,
} from "../../core/editor-bridge.ts";
import type { DocumentSession } from "../../core/session.ts";
import { CLIPBOARD_TYPE, clipboardJson, clipboardText, readClipboard, selectedParagraphs, type Pasted } from "./clipboard.ts";
import { charactersAt, liveRanges, relativeAt } from "./positions.ts";
import { deleteInDocument, replaceInDocument } from "./replace.ts";
import {
  EMPTY_ENTER, enterContext, nextElement, parentheticalInput, suggestions, tabAction, typedText, unwrapParenthetical, type Suggestions,
} from "./rules.ts";
import {
  bodyIndexOf, buildDoc, paragraphCount, paragraphPositions, sameDisplay, sameToken, schema, tokensBetween, topNodes, type Token,
} from "./schema.ts";

/** Marks transactions that redraw from the engine, so they are not replayed back onto it. */
const SYNC = "editor-sync";
const PAGE_SOURCE = "editor:pages";
const CURSOR_SOURCE = "editor:cursors";
const GHOST_SOURCE = "editor:ghost";
const CARET_KEY = "editor-caret";
const PLACEHOLDER = "INT. LOCATION - DAY";
const DIALOGUE_FAMILY: ReadonlySet<ElementType> = new Set(["character", "parenthetical", "dialogue", "lyrics"]);
/** What an empty read-only script shows: a line that is not in the document. */
const EMPTY_LINE: Paragraph = { id: "", type: "sceneHeading", runs: [] };

/** A caret end: a text position, or an engine body offset to resolve after the edit. */
type Target = TextPosition | number;
interface TargetSelection {
  anchor: Target;
  head: Target;
}

export interface SmartTypeState extends Suggestions {
  paragraphId: string;
  index: number;
  left: number;
  top: number;
}

interface Range {
  from: TextPosition;
  to: TextPosition;
  collapsed: boolean;
}

function samePosition(a: TextPosition, b: TextPosition): boolean {
  return a.paragraphId === b.paragraphId && a.offset === b.offset;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Length of the character (grapheme) before or after an offset, so Backspace removes a whole emoji. */
function graphemeLength(text: string, offset: number, forward: boolean): number {
  if (forward) {
    const first = segmenter.segment(text.slice(offset, offset + 16))[Symbol.iterator]().next();
    return first.done ? 0 : first.value.segment.length;
  }
  const piece = text.slice(Math.max(0, offset - 16), offset);
  let last = "";
  for (const { segment } of segmenter.segment(piece)) last = segment;
  return last.length;
}

function marksFromKey(key: string): Marks {
  const names = new Set(key ? key.split("+") : []);
  const marks: Record<string, boolean> = Object.fromEntries(MARKS.map((mark) => [mark, names.has(mark)]));
  marks.note = names.has("note");
  return marks as Marks;
}

/**
 * The drawing counts each paragraph as a line break and its text. The body has the first paragraph's lead (text a
 * co-writer left before its line break, ScreenplayDoc.lead) before that line break, so a caret inside the lead is one
 * less in the body. Elsewhere the two agree.
 */
function bodyOffset(offset: number, lead: number): number {
  return offset >= 1 && offset <= lead ? offset - 1 : offset;
}

/** The body ranges of the characters between two offsets in the drawing; the drawing's first character is the line break after the lead. */
function bodyRanges(from: number, to: number, lead: number): [number, number][] {
  if (!lead) return [[from, to]];
  const ranges: [number, number][] = [];
  if (from === 0 && to > 0) ranges.push([lead, lead + 1]);
  const a = Math.max(from, 1), b = Math.min(to, lead + 1);
  if (b > a) ranges.push([a - 1, b - 1]);
  const c = Math.max(from, lead + 1);
  if (to > c) ranges.push([c, to]);
  return ranges;
}

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|hsl)a?\([\d\s.,%]+\))$/i;

export interface EditorOptions {
  /** Commands whose accelerators the editor runs itself while it has focus. */
  commands: () => Command[];
}

export class EditorController implements EditorBridge {
  readonly view: EditorView;
  session!: DocumentSession;
  smart: SmartTypeState | null = null;
  private ghost: GhostText | null = null;
  private readonly options: EditorOptions;
  /** The engine paragraphs and the ProseMirror document as last drawn. */
  private drawn: readonly Paragraph[] = [];
  private drawnDoc!: PMNode;
  /** The length of the first paragraph's lead as drawn (see bodyOffset). */
  private drawnLead = 0;
  private positions: { doc: PMNode; map: Map<string, number> } | null = null;
  private decorations = DecorationSet.empty;
  /** Re-pagination can preserve every boundary; avoid expensive unchanged widget redraws. */
  private pageBreakSnapshot: string | null = null;
  private pending: TargetSelection | null = null;
  private changing = false;
  private syncs = 0;
  private deferred = false;
  private caretBefore: Selection | null = null;
  /** The document as last drawn, kept while a composition is open and the document has moved on since. */
  private drawnState: Y.Snapshot | null = null;
  private relative: { anchor: Y.RelativePosition; head: Y.RelativePosition } | null = null;
  private storedMarks: Marks | null = null;
  private readonly selectionListeners = new Set<(selection: Selection | null) => void>();
  private readonly plainTextPasteListeners = new Set<(text: string) => boolean>();
  private readonly smartListeners = new Set<() => void>();
  private unbind: (() => void) | null = null;
  private readonly offSession: () => void;

  constructor(mount: HTMLElement, session: DocumentSession, options: EditorOptions) {
    this.options = options;
    this.view = new EditorView(mount, {
      state: EditorState.create({ schema }),
      dispatchTransaction: (tr) => this.dispatch(tr),
      handleTextInput: (_view, from, to, text) => this.textInput(from, to, text),
      handleKeyDown: (_view, event) => this.keyDown(event),
      handleClick: (_view, pos) => this.click(pos),
      handleDrop: (_view, event, _slice, moved) => this.drop(event, moved),
      decorations: (state) => this.withPlaceholder(state.doc),
      // A read-only session (a read-only co-writing invite) shows the script but takes no typing.
      editable: () => !this.session?.readOnly,
      attributes: { class: "editor-pm", spellcheck: "true", autocorrect: "off", autocapitalize: "off", role: "textbox", "aria-multiline": "true", "aria-label": "Script" },
      handleDOMEvents: {
        beforeinput: (_view, event) => this.beforeInput(event as InputEvent),
        copy: (_view, event) => this.copy(event as ClipboardEvent, false),
        cut: (_view, event) => this.copy(event as ClipboardEvent, true),
        paste: (_view, event) => this.paste(event as ClipboardEvent),
        compositionend: () => {
          setTimeout(() => this.afterComposition(), 40);
          return false;
        },
        blur: () => {
          this.closeSmart();
          return false;
        },
      },
    });
    this.bind(session);
    this.offSession = app.onSession((next) => this.bind(next));
  }

  /** Draw a session's document and follow its changes. */
  bind(session: DocumentSession): void {
    this.unbind?.();
    this.session = session;
    const doc = session.doc;
    if (!doc.paragraphs().length && !session.readOnly) doc.ydoc.transact(() => doc.insertParagraph(0, { type: "sceneHeading" }), "editor");
    this.drawn = doc.paragraphs().length ? doc.paragraphs() : [EMPTY_LINE];
    this.drawnState = null;
    const pmDoc = buildDoc(this.drawn);
    this.decorations = DecorationSet.empty;
    this.pageBreakSnapshot = null;
    this.view.updateState(EditorState.create({ doc: pmDoc, selection: PMSelection.atStart(pmDoc) }));
    this.drawnDoc = this.view.state.doc;
    this.drawnLead = doc.lead();
    this.closeSmart();

    const onBody = () => this.sync();
    const offState = session.onState(() => {
      this.view.setProps({});
      // Writable again with an empty script: give it its first line now.
      if (!session.readOnly && !doc.paragraphs().length) this.sync();
    });
    const before = () => this.beforeTransaction();
    const added = (event: { stackItem: { meta: Map<unknown, unknown> } }) => event.stackItem.meta.set(CARET_KEY, this.caretBefore);
    const popped = (event: { stackItem: { meta: Map<unknown, unknown> } }) => {
      const caret = event.stackItem.meta.get(CARET_KEY) as Selection | null | undefined;
      if (caret) this.setSelection(caret.anchor, caret.head);
    };
    // Letters a co-writer deletes during a composition are kept whole until it commits. Yjs empties a collected
    // letter, and a later split of it no longer counts as text, which would shift the drawn offsets (positions.ts).
    const gcFilter = doc.ydoc.gcFilter;
    doc.ydoc.gcFilter = (item) => !this.drawnState && gcFilter(item);
    doc.body.observe(onBody);
    doc.ydoc.on("beforeTransaction", before);
    session.undo.on("stack-item-added", added);
    session.undo.on("stack-item-popped", popped);
    this.view.setProps({});
    this.unbind = () => {
      offState();
      doc.ydoc.gcFilter = gcFilter;
      doc.body.unobserve(onBody);
      doc.ydoc.off("beforeTransaction", before);
      session.undo.off("stack-item-added", added);
      session.undo.off("stack-item-popped", popped);
    };
    this.emitSelection();
  }

  destroy(): void {
    this.unbind?.();
    this.offSession();
    this.view.destroy();
    this.selectionListeners.clear();
    this.plainTextPasteListeners.clear();
    this.smartListeners.clear();
  }

  // Engine to view.

  private beforeTransaction(): void {
    // The first co-writer's change during a composition: remember the document as drawn, so the composition's
    // offsets, which count in the drawing, can be found again in the changed text when it commits.
    if (this.composed() && !this.changing && !this.deferred && !this.drawnState) this.drawnState = Y.snapshot(this.session.doc.ydoc);
    this.caretBefore = this.getSelection();
    this.relative = null;
    if (this.changing || !this.caretBefore) return;
    const doc = this.session.doc;
    // Tied to the character before the caret, so a caret at the end of a paragraph stays there when a co-writer
    // presses Return at the same spot (tied to the next character, it would jump into their new paragraph).
    const relative = (at: Position) => doc.has(at.paragraphId) ? Y.createRelativePositionFromTypeIndex(doc.body, doc.bodyIndex(at), -1) : null;
    const anchor = relative(this.caretBefore.anchor), head = relative(this.caretBefore.head);
    if (anchor && head) this.relative = { anchor, head };
  }

  /**
   * Whether the view holds composed text the engine does not have yet: a composition is open, or the input
   * method has confirmed it and afterComposition has not committed it. This editor's own edits (`changing`)
   * commit that text themselves.
   */
  private composed(): boolean {
    return this.view.composing || (!this.changing && this.view.state.doc !== this.drawnDoc);
  }

  /** Redraw what changed in the Y.Text and put the caret back. */
  private sync(): void {
    if (this.composed()) {
      // Redrawing now would draw over the composed text. It commits first, then the redraw follows; a confirmed
      // composition commits on the timer compositionend started, and this one makes sure a commit comes.
      if (!this.view.composing) setTimeout(() => this.afterComposition(), 40);
      this.deferred = true;
      return;
    }
    this.deferred = false;
    this.drawnState = null;
    const doc = this.session.doc;
    let next = doc.paragraphs();
    if (!next.length) {
      if (!this.session.readOnly) {
        queueMicrotask(() => this.session.readOnly || doc.ydoc.transact(() => doc.paragraphs().length || doc.insertParagraph(0, { type: "action" }), "editor"));
        return;
      }
      // A read-only script may not be written to, so an empty one is drawn as one empty line.
      next = [EMPTY_LINE];
    }
    const previous = this.getSelection();
    const tr = this.view.state.tr;
    this.redraw(tr, this.drawn, next);
    this.drawn = next;
    this.drawnLead = doc.lead();
    // A caret this editor's own edit chose; otherwise the caret follows the text it was in (co-writing,
    // undo, another feature's replaceText).
    const target: TargetSelection | null = this.pending ?? this.followingSelection() ?? previous;
    if (target) this.applySelection(tr, target);
    if (this.pending) tr.scrollIntoView();
    tr.setMeta(SYNC, true);
    this.syncs++;
    this.view.dispatch(tr);
    this.drawnDoc = this.view.state.doc;
  }

  private followingSelection(): TargetSelection | null {
    if (!this.relative) return null;
    const ydoc = this.session.doc.ydoc;
    const anchor = Y.createAbsolutePositionFromRelativePosition(this.relative.anchor, ydoc);
    const head = Y.createAbsolutePositionFromRelativePosition(this.relative.head, ydoc);
    return anchor && head ? { anchor: anchor.index, head: head.index } : null;
  }

  /**
   * Replace the drawing of paragraphs that changed. Unchanged paragraphs are the same objects (the engine
   * keeps them), so the common prefix and suffix are found by identity; dual-dialogue blocks are redrawn
   * whole. Within that range only the part that differs is replaced, so decorations elsewhere stay put.
   */
  private redraw(tr: Transaction, previous: readonly Paragraph[], next: readonly Paragraph[]): void {
    const min = Math.min(previous.length, next.length);
    let head = 0;
    while (head < min && sameDisplay(previous[head]!, next[head]!)) head++;
    let tail = 0;
    while (tail < min - head && sameDisplay(previous[previous.length - 1 - tail]!, next[next.length - 1 - tail]!)) tail++;
    if (head === previous.length && head === next.length) return;
    const continues = (list: readonly Paragraph[], i: number) =>
      i > 0 && i < list.length && !!list[i]!.dual && list[i]!.dual?.block === list[i - 1]!.dual?.block;
    for (let moved = true; moved; ) {
      moved = false;
      if (head > 0 && (continues(previous, head) || continues(next, head))) (head--, (moved = true));
      if (tail > 0 && (continues(previous, previous.length - tail) || continues(next, next.length - tail))) (tail--, (moved = true));
    }
    const doc = tr.doc;
    let from = -1, to = -1, count = 0;
    doc.forEach((child, offset) => {
      if (count === head && from < 0) from = offset;
      if (count === previous.length - tail && to < 0) to = offset;
      count += paragraphCount(child);
    });
    if (from < 0) from = doc.content.size;
    if (to < 0) to = doc.content.size;
    const before = doc.slice(from, to).content;
    const after = Fragment.from(topNodes(next.slice(head, next.length - tail)));
    const start = before.findDiffStart(after);
    if (start === null) return;
    let { a: endA, b: endB } = before.findDiffEnd(after)!;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) (endA += overlap, endB += overlap);
    const replacement = schema.topNodeType.create(null, after).slice(start, endB);
    tr.replace(from + start, from + endA, replacement);
  }

  // View to engine.

  private dispatch(tr: Transaction): void {
    const state = this.view.state;
    const sync = !!tr.getMeta(SYNC);
    // During IME composition ProseMirror keeps its own text; it reaches the engine when composition ends.
    if (!sync && tr.docChanged && !this.view.composing) return this.commit(state.apply(tr));
    if (tr.docChanged) this.decorations = this.decorations.map(tr.mapping, tr.doc);
    this.view.updateState(state.apply(tr));
    if (!sync && tr.selectionSet) {
      this.storedMarks = null;
      this.closeSmart();
    }
    if (tr.docChanged || !state.selection.eq(this.view.state.selection)) this.emitSelection();
  }

  /** Replay a change ProseMirror made to its own document onto the engine. */
  private commit(next: EditorState): void {
    const before = this.drawnDoc, after = next.doc;
    const start = before.content.findDiffStart(after.content);
    if (start === null) {
      this.view.updateState(this.view.state);
      return;
    }
    let { a: endA, b: endB } = before.content.findDiffEnd(after.content)!;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) (endA += overlap, endB += overlap);
    const removed = tokensBetween(before, start, endA), added = tokensBetween(after, start, endB);
    let head = 0;
    while (head < removed.length && head < added.length && sameToken(removed[head]!, added[head]!)) head++;
    let tail = 0;
    while (tail < removed.length - head && tail < added.length - head && sameToken(removed[removed.length - 1 - tail]!, added[added.length - 1 - tail]!)) tail++;
    const index = bodyIndexOf(before, start) + head;
    const count = removed.length - head - tail;
    const inserts = added.slice(head, added.length - tail);
    const selection = { anchor: bodyIndexOf(after, next.selection.anchor), head: bodyIndexOf(after, next.selection.head) };
    // These offsets count in the drawing (see bodyOffset). When a co-writer changed the document during a
    // composition, they are carried onto today's text as relative positions taken in the document as drawn, and the
    // replaced text is the characters that were drawn there, so a co-writer's text typed in between since is kept.
    const state = this.drawnState;
    const ydoc = this.session.doc.ydoc;
    const lead = this.drawnLead;
    const drawnOffset = (offset: number) => (offset <= index ? offset : Math.max(index + count, offset - inserts.length + count));
    const anchors = state ? [index, drawnOffset(selection.anchor), drawnOffset(selection.head)].map((offset) => relativeAt(this.session.doc.body, state, bodyOffset(offset, lead))) : null;
    let replaced: Map<number, number[]> | null = null;
    if (state && count) {
      replaced = new Map();
      for (const [from, to] of bodyRanges(index, index + count, lead)) {
        for (const [client, clocks] of charactersAt(this.session.doc.body, state, from, to)) replaced.set(client, [...(replaced.get(client) ?? []), ...clocks].sort((a, b) => a - b));
      }
    }
    const absolute = (position: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(position, ydoc)?.index ?? 0;
    const syncs = this.syncs;
    this.change((doc) => {
      if (!anchors) {
        const from = doc.positionAt(bodyOffset(index, lead));
        if (!from) return;
        if (count) doc.deleteRange(from, doc.positionAt(bodyOffset(index + count, lead))!);
        this.insertTokens(doc, from, inserts);
        // The caret counts in the new drawing, which is the engine's text now.
        const now = doc.lead();
        return { anchor: bodyOffset(selection.anchor, now), head: bodyOffset(selection.head, now) };
      }
      if (replaced) for (const [start, end] of liveRanges(doc.body, replaced).reverse()) doc.deleteRange(doc.positionAt(start)!, doc.positionAt(end)!);
      // The first replaced character, deleted now, resolves to where it was.
      const from = doc.positionAt(absolute(anchors[0]!));
      if (!from) return;
      const end = this.insertTokens(doc, from, inserts);
      // A caret after the committed text stays after it, also when a co-writer's text now follows it.
      const place = (offset: number, drawn: Y.RelativePosition) => (offset === index + inserts.length ? end : absolute(drawn));
      return { anchor: place(selection.anchor, anchors[1]!), head: place(selection.head, anchors[2]!) };
    });
    // Nothing changed in the engine: redraw the paragraphs the browser edited.
    if (this.syncs === syncs) this.view.updateState(this.view.state);
  }

  /** Insert drawn tokens at a position; returns the position just after them. */
  private insertTokens(doc: ScreenplayDoc, at: TextPosition, tokens: Token[]): TextPosition {
    let position = { ...at };
    let text = "";
    let marks = "";
    const flush = () => {
      if (!text) return;
      const typed = typedText(doc.paragraphs()[doc.indexOf(position.paragraphId)]!.type, text);
      doc.insertText(position.paragraphId, position.offset, typed, marksFromKey(marks));
      position = { ...position, offset: position.offset + typed.length };
      text = "";
    };
    for (const token of tokens) {
      if ("type" in token) {
        flush();
        position = this.splitAt(doc, position, token.type);
      } else {
        if (token.marks !== marks) (flush(), (marks = token.marks));
        text += token.char;
      }
    }
    flush();
    return position;
  }

  /** Start a paragraph of `type` at a position: the text after it moves into that paragraph. */
  private splitAt(doc: ScreenplayDoc, at: TextPosition, type: ElementType): TextPosition {
    const paragraph = doc.paragraph(at.paragraphId);
    if (at.offset === 0 && plainText(paragraph.runs).length > 0) {
      // The engine opens a line above and leaves the text with its ID; swap the types to match.
      doc.splitParagraph(at.paragraphId, 0, paragraph.type);
      doc.setType(at.paragraphId, type);
      return { paragraphId: at.paragraphId, offset: 0 };
    }
    return { paragraphId: doc.splitParagraph(at.paragraphId, at.offset, type), offset: 0 };
  }

  private afterComposition(): void {
    if (this.view.composing) return;
    if (!this.view.state.doc.eq(this.drawnDoc)) this.commit(this.view.state);
    // Nothing reached the engine (the same text, or a commit it refused): take the view as drawn, so the redraw
    // below is not deferred again.
    if (this.view.state.doc !== this.drawnDoc) this.drawnDoc = this.view.state.doc;
    if (this.deferred) {
      this.deferred = false;
      this.sync();
    }
  }

  /** Run engine edits as one undoable change; the result says where the caret goes. */
  private change(run: (doc: ScreenplayDoc) => TargetSelection | TextPosition | void): void {
    if (this.session.readOnly) return;
    const syncs = this.syncs;
    let target: TargetSelection | null = null;
    this.changing = true;
    try {
      this.session.edit(() => {
        const result = run(this.session.doc);
        if (result) this.pending = target = "paragraphId" in result ? { anchor: result, head: result } : result;
      });
    } finally {
      this.changing = false;
      this.pending = null;
    }
    if (this.syncs === syncs && target) this.select(target);
  }

  // Positions.

  private positionMap(doc: PMNode): Map<string, number> {
    if (this.positions?.doc !== doc) this.positions = { doc, map: paragraphPositions(doc) };
    return this.positions.map;
  }

  private pmPosition(doc: PMNode, target: Target): number | null {
    const at = typeof target === "number" ? this.session.doc.positionAt(target) : target;
    if (!at) return null;
    const start = this.positionMap(doc).get(at.paragraphId);
    if (start === undefined) return null;
    const node = doc.nodeAt(start)!;
    return start + 1 + Math.max(0, Math.min(at.offset, node.content.size));
  }

  private textPosition(doc: PMNode, pos: number, bias: 1 | -1): TextPosition | null {
    let $pos = doc.resolve(pos);
    if ($pos.parent.type !== schema.nodes.paragraph) {
      const near = PMSelection.findFrom($pos, bias, true) ?? PMSelection.findFrom($pos, -bias as 1 | -1, true);
      if (!near) return null;
      $pos = near.$head;
    }
    return { paragraphId: $pos.parent.attrs.id, offset: $pos.parentOffset };
  }

  private applySelection(tr: Transaction, target: TargetSelection): boolean {
    const anchor = this.pmPosition(tr.doc, target.anchor);
    const head = this.pmPosition(tr.doc, target.head);
    if (anchor === null || head === null) return false;
    tr.setSelection(TextSelection.create(tr.doc, anchor, head));
    return true;
  }

  private select(target: TargetSelection, scroll = true): void {
    const tr = this.view.state.tr;
    if (!this.applySelection(tr, target)) return;
    if (scroll) tr.scrollIntoView();
    tr.setMeta(SYNC, true);
    this.view.dispatch(tr);
  }

  /** The selection in script order. */
  private range(): Range | null {
    const selection = this.getSelection();
    if (!selection) return null;
    const doc = this.session.doc;
    const { anchor, head } = selection;
    if (!doc.has(anchor.paragraphId) || !doc.has(head.paragraphId)) return null;
    const forward = doc.bodyIndex(anchor) <= doc.bodyIndex(head);
    const from = forward ? anchor : head, to = forward ? head : anchor;
    return { from, to, collapsed: samePosition(from, to) };
  }

  /** The part of each paragraph a range covers. */
  private pieces(range: Range): { id: string; from: number; to: number; paragraph: Paragraph }[] {
    const paragraphs = this.session.doc.paragraphs();
    const first = this.session.doc.indexOf(range.from.paragraphId), last = this.session.doc.indexOf(range.to.paragraphId);
    return paragraphs.slice(first, last + 1).map((paragraph, i) => ({
      id: paragraph.id, paragraph,
      from: i === 0 ? range.from.offset : 0,
      to: first + i === last ? range.to.offset : plainText(paragraph.runs).length,
    }));
  }

  // Input.

  /** Typed text, already in the DOM; the engine gets it with caps and parentheses applied, and the paragraph is redrawn. */
  textInput(from: number, to: number, text: string): boolean {
    if (this.session.readOnly) return true;
    // Composition text stays in ProseMirror until the input method commits it; then the whole change is
    // diffed against the last drawing (commit), since these positions would not match the engine.
    if (this.view.composing || this.view.state.doc !== this.drawnDoc) return false;
    const doc = this.view.state.doc;
    const a = this.textPosition(doc, from, 1), b = this.textPosition(doc, to, -1);
    if (!a || !b || !this.session.doc.has(a.paragraphId) || !this.session.doc.has(b.paragraphId)) return false;
    const marks = this.storedMarks;
    this.change((engine) => {
      if (!samePosition(a, b)) engine.deleteRange(a, b);
      return this.typeAt(engine, a, text, marks);
    });
    this.storedMarks = null;
    this.refreshSmart(true);
    return true;
  }

  private typeAt(doc: ScreenplayDoc, at: TextPosition, text: string, marks: Marks | null): TextPosition {
    const paragraph = doc.paragraph(at.paragraphId);
    const typed = text === "\n" ? text : typedText(paragraph.type, text);
    if (paragraph.type === "parenthetical") {
      const plan = parentheticalInput(plainText(paragraph.runs), at.offset, typed);
      if (plan) {
        if (plan.insert) doc.insertText(at.paragraphId, plan.at, plan.insert, marks ?? {});
        return { paragraphId: at.paragraphId, offset: plan.caret };
      }
    }
    doc.insertText(at.paragraphId, at.offset, typed, marks ?? {});
    return { paragraphId: at.paragraphId, offset: at.offset + typed.length };
  }

  private keyDown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229 || this.view.composing) return false;
    if (this.view.state.doc !== this.drawnDoc) this.commit(this.view.state);
    if (this.ghost && this.ghostKey(event)) return true;
    if (this.smart && this.smartKey(event)) return true;
    if (event.key === "Escape" && app.ui.focusMode) { app.setFocusMode(false); return true; }
    const modified = event.metaKey || event.ctrlKey || event.altKey;
    // Read-only: keys that would edit do nothing, and the browser must not edit the DOM behind the engine.
    if (this.session.readOnly && !modified && ["Enter", "Tab", "Backspace", "Delete"].includes(event.key)) return true;
    switch (event.key) {
      case "Enter":
        if (event.metaKey || event.ctrlKey) break;
        if (event.shiftKey) this.insertLineBreak();
        else this.enter();
        return true;
      case "Tab":
        if (modified) break;
        this.tab(event.shiftKey);
        return true;
      case "Backspace":
        return modified ? false : this.backspace();
      case "Delete":
        return modified ? false : this.forwardDelete();
    }
    if (!event.metaKey && !event.ctrlKey) return false;
    // In the app a real key press for a menu command never gets here: the main process takes it first and runs
    // the command (src/main/index.ts). Keys that do arrive (a browser, synthetic test input) run here, once,
    // and the handled key is cancelled so neither the window's handler nor the menu sees it again.
    const command = this.options.commands().find((c) => c.accelerator && matchesAccelerator(event, c.accelerator));
    if (!command) return false;
    void app.runCommand(command.id);
    return true;
  }

  private beforeInput(event: InputEvent): boolean {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      if (event.inputType === "historyUndo") this.session.undo.undo();
      else this.session.undo.redo();
      return true;
    }
    // Native formatting would change the DOM behind the engine's back; the Format menu does it instead.
    if (event.inputType.startsWith("format")) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  /** Return: a new paragraph of the next element, Final Draft style. */
  enter(): void {
    const range = this.range();
    if (!range) return;
    const overrides = { ...returnKeyFlow(this.session.script()), ...app.setting<Partial<Record<ElementType, ElementType>>>("editor.nextElement", {}) };
    this.change((doc) => {
      if (!range.collapsed) doc.deleteRange(range.from, range.to);
      const at = range.from, id = at.paragraphId;
      const paragraph = doc.paragraph(id);
      const text = plainText(paragraph.runs), length = text.length;
      const { empty, atEnd } = enterContext(paragraph.type, text, at.offset);
      const changed = EMPTY_ENTER[paragraph.type];
      if (empty && changed) {
        if (length) doc.deleteText(id, 0, length);
        doc.setType(id, changed);
        return { paragraphId: id, offset: 0 };
      }
      if (at.offset === 0 && length && !atEnd) {
        doc.splitParagraph(id, 0, paragraph.type);
        return at;
      }
      if (!atEnd) return { paragraphId: doc.splitParagraph(id, at.offset), offset: 0 };
      const type = nextElement(paragraph.type, overrides);
      if (paragraph.dual && !DIALOGUE_FAMILY.has(type)) {
        // Leaving dual dialogue: the new paragraph goes below the whole block.
        const paragraphs = doc.paragraphs();
        let last = doc.indexOf(id);
        while (last + 1 < paragraphs.length && paragraphs[last + 1]!.dual?.block === paragraph.dual.block) last++;
        return { paragraphId: doc.insertParagraph(last + 1, { type }), offset: 0 };
      }
      return { paragraphId: doc.splitParagraph(id, length, type), offset: 0 };
    });
    this.closeSmart();
  }

  insertLineBreak(): void {
    const range = this.range();
    if (!range) return;
    this.change((doc) => {
      if (!range.collapsed) doc.deleteRange(range.from, range.to);
      return this.typeAt(doc, range.from, "\n", null);
    });
  }

  tab(shift: boolean): void {
    const range = this.range();
    if (!range || !range.collapsed) return;
    const at = range.from, id = at.paragraphId;
    this.change((doc) => {
      const paragraph = doc.paragraph(id);
      const text = plainText(paragraph.runs);
      const action = tabAction(paragraph.type, !text, shift);
      const dual = paragraph.dual ? { dual: paragraph.dual } : {};
      if (!action) return;
      if (action.kind === "setType") {
        doc.setType(id, action.type);
        return at;
      }
      if (action.kind === "parenthetical") {
        if (!text) {
          doc.setType(id, "parenthetical");
          doc.insertText(id, 0, "()");
          return { paragraphId: id, offset: 1 };
        }
        let created: string;
        if (at.offset === 0) created = doc.insertParagraph(doc.indexOf(id), { type: "parenthetical", runs: [{ text: "()" }], ...dual });
        else if (at.offset >= text.length) {
          created = doc.splitParagraph(id, text.length, "parenthetical");
          doc.insertText(created, 0, "()");
        } else {
          const rest = doc.splitParagraph(id, at.offset, "dialogue");
          created = doc.insertParagraph(doc.indexOf(rest), { type: "parenthetical", runs: [{ text: "()" }], ...dual });
        }
        return { paragraphId: created, offset: 1 };
      }
      if (!text || text === "()") {
        if (text) doc.deleteText(id, 0, text.length);
        doc.setType(id, "dialogue");
        return { paragraphId: id, offset: 0 };
      }
      const following = doc.paragraphs()[doc.indexOf(id) + 1];
      if (following?.type === "dialogue" && !plainText(following.runs)) return { paragraphId: following.id, offset: 0 };
      return { paragraphId: doc.splitParagraph(id, text.length, "dialogue"), offset: 0 };
    });
    this.closeSmart();
  }

  backspace(): boolean {
    const range = this.range();
    if (!range) return false;
    if (!range.collapsed) {
      this.change((doc) => (doc.deleteRange(range.from, range.to), range.from));
      this.closeSmart();
      return true;
    }
    const at = range.from, id = at.paragraphId;
    const doc = this.session.doc;
    if (at.offset > 0) {
      const size = graphemeLength(plainText(doc.paragraphs()[doc.indexOf(id)]!.runs), at.offset, false);
      this.change((engine) => (engine.deleteText(id, at.offset - size, size), { paragraphId: id, offset: at.offset - size }));
      this.refreshSmart(true);
      return true;
    }
    const index = doc.indexOf(id);
    if (index === 0) return true;
    const previousLength = plainText(doc.paragraphs()[index - 1]!.runs).length;
    this.change((engine) => {
      const kept = engine.mergeWithPrevious(id);
      return kept === id ? { paragraphId: id, offset: 0 } : { paragraphId: kept, offset: previousLength };
    });
    this.closeSmart();
    return true;
  }

  forwardDelete(): boolean {
    const range = this.range();
    if (!range) return false;
    if (!range.collapsed) return this.backspace();
    const at = range.from, id = at.paragraphId;
    const doc = this.session.doc;
    const paragraphs = doc.paragraphs();
    const index = doc.indexOf(id);
    const text = plainText(paragraphs[index]!.runs);
    if (at.offset < text.length) {
      const size = graphemeLength(text, at.offset, true);
      this.change((engine) => (engine.deleteText(id, at.offset, size), at));
      return true;
    }
    const following = paragraphs[index + 1];
    if (!following) return true;
    this.change((engine) => {
      const kept = engine.mergeWithPrevious(following.id);
      return kept === following.id ? { paragraphId: kept, offset: 0 } : at;
    });
    return true;
  }

  // Clipboard.

  private copy(event: ClipboardEvent, cut: boolean): boolean {
    const range = this.range();
    if (!range || range.collapsed || !event.clipboardData) return false;
    event.preventDefault();
    const paragraphs = selectedParagraphs(this.session.doc.paragraphs(), range.from, range.to);
    event.clipboardData.setData("text/plain", clipboardText(paragraphs));
    event.clipboardData.setData(CLIPBOARD_TYPE, clipboardJson(paragraphs));
    if (cut) this.change((doc) => (doc.deleteRange(range.from, range.to), range.from));
    return true;
  }

  private paste(event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (!data) return false;
    event.preventDefault();
    this.pasteData(data.getData(CLIPBOARD_TYPE) || undefined, data.getData("text/plain") || undefined);
    return true;
  }

  /** Paste clipboard contents at the selection: runs into the paragraph, or whole paragraphs. */
  pasteData(json: string | undefined, text: string | undefined): void {
    if (!json && text && !this.session.readOnly) {
      for (const listener of this.plainTextPasteListeners) {
        if (listener(text)) {
          this.closeSmart();
          return;
        }
      }
    }
    const pasted = readClipboard(json, text, this.session.script());
    const range = this.range();
    if (!pasted || !range) return;
    this.change((doc) => {
      if (!range.collapsed) doc.deleteRange(range.from, range.to);
      return this.insertPasted(doc, range.from, pasted);
    });
    this.closeSmart();
  }

  private insertPasted(doc: ScreenplayDoc, at: TextPosition, pasted: Pasted): TextPosition {
    if ("runs" in pasted) return this.insertRuns(doc, at, pasted.runs);
    const ids = doc.insertParagraphsAt(at, pasted.paragraphs);
    const last = ids.at(-1);
    return last ? { paragraphId: last, offset: plainText(doc.paragraphs()[doc.indexOf(last)]!.runs).length } : at;
  }

  /**
   * Drag and drop. Moving text deletes it at the source and inserts it at the drop point, so the
   * paragraphs in between keep their IDs (a diff of ProseMirror's move would rewrite all of them).
   */
  private drop(event: DragEvent, moved: boolean): boolean {
    const found = this.view.posAtCoords({ left: event.clientX, top: event.clientY });
    const target = found && this.textPosition(this.view.state.doc, found.pos, 1);
    const doc = this.session.doc;
    if (!target || !doc.has(target.paragraphId)) return false;
    const range = moved ? this.range() : null;
    let pasted: Pasted | null;
    if (range && !range.collapsed) {
      const at = doc.bodyIndex(target);
      if (at >= doc.bodyIndex(range.from) && at <= doc.bodyIndex(range.to)) return true;
      const json = clipboardJson(selectedParagraphs(doc.paragraphs(), range.from, range.to));
      pasted = readClipboard(json, undefined, this.session.script());
    } else {
      pasted = readClipboard(
        event.dataTransfer?.getData(CLIPBOARD_TYPE) || undefined,
        event.dataTransfer?.getData("text/plain") || undefined,
        this.session.script(),
      );
    }
    if (!pasted) return false;
    const content = pasted;
    this.change((engine) => {
      const anchor = Y.createRelativePositionFromTypeIndex(engine.body, engine.bodyIndex(target));
      if (range && !range.collapsed) engine.deleteRange(range.from, range.to);
      const index = Y.createAbsolutePositionFromRelativePosition(anchor, engine.ydoc)?.index;
      const at = index === undefined ? null : engine.positionAt(index);
      return at ? this.insertPasted(engine, at, content) : undefined;
    });
    return true;
  }

  private insertRuns(doc: ScreenplayDoc, at: TextPosition, runs: Run[]): TextPosition {
    const type = doc.paragraphs()[doc.indexOf(at.paragraphId)]!.type;
    let offset = at.offset;
    for (const run of runs) {
      const text = typedText(type, run.text);
      const marks = Object.fromEntries(MARKS.map((mark) => [mark, !!run[mark]])) as Marks;
      doc.insertText(at.paragraphId, offset, text, marks);
      offset += text.length;
    }
    return { paragraphId: at.paragraphId, offset };
  }

  // SmartType.

  private refreshSmart(show: boolean): void {
    const range = show ? this.range() : null;
    if (!range?.collapsed) return this.closeSmart();
    const doc = this.session.doc;
    const paragraphs = doc.paragraphs();
    const paragraph = paragraphs[doc.indexOf(range.from.paragraphId)]!;
    const result = suggestions(paragraph.type, plainText(paragraph.runs), range.from.offset, paragraphs, doc.meta.get("editor.smartType.v1"));
    if (!result) return this.closeSmart();
    let left = 0, top = 0;
    try {
      const coords = this.view.coordsAtPos(this.view.state.selection.head);
      left = coords.left;
      top = coords.bottom;
    } catch {
      // No layout yet; the popup shows at the corner.
    }
    this.smart = { ...result, paragraphId: paragraph.id, index: 0, left, top };
    this.emitSmart();
  }

  closeSmart(): void {
    if (!this.smart) return;
    this.smart = null;
    this.emitSmart();
  }

  private ghostKey(event: KeyboardEvent): boolean {
    const ghost = this.ghost!;
    if (event.key === "Escape") { this.clearGhost(); return true; }
    if (event.key !== "ArrowRight" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || ghost.pending || !ghost.text) return false;
    const selection = this.getSelection();
    const at = (p: Position | undefined) => p?.paragraphId === ghost.paragraphId && p.offset === ghost.offset;
    if (!at(selection?.anchor) || !at(selection?.head)) return false;
    // Its own undo step: neither the typing before it nor the typing after it is undone with it.
    this.session.undo.stopCapturing();
    this.change((doc) => {
      doc.insertText(ghost.paragraphId, ghost.offset, ghost.text);
      return { paragraphId: ghost.paragraphId, offset: ghost.offset + ghost.text.length };
    });
    this.session.undo.stopCapturing();
    return true;
  }

  private clearGhost(): void {
    const ghost = this.ghost;
    if (!ghost) return;
    this.setGhostText(null);
    ghost.onDismiss?.();
  }

  setGhostText(ghost: GhostText | null): void {
    if (!ghost && !this.ghost) return;
    this.ghost = ghost;
    const pos = ghost ? this.pmPosition(this.view.state.doc, ghost) : null;
    this.replaceDecorations(GHOST_SOURCE, ghost && pos !== null ? [Decoration.widget(pos, () => ghostWidget(ghost), {
      side: 1, key: `ghost-${ghost.pending ? "pending" : ghost.text}`, source: GHOST_SOURCE, ignoreSelection: true,
    })] : []);
  }

  private smartKey(event: KeyboardEvent): boolean {
    const smart = this.smart!;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.smart = { ...smart, index: (smart.index + step + smart.items.length) % smart.items.length };
      this.emitSmart();
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      this.acceptSmart(smart.index);
      return true;
    }
    if (event.key === "Escape") {
      this.closeSmart();
      return true;
    }
    return false;
  }

  acceptSmart(index: number): void {
    const smart = this.smart;
    const item = smart?.items[index];
    if (!smart || item === undefined) return;
    this.change((doc) => {
      doc.deleteText(smart.paragraphId, smart.from, smart.to - smart.from);
      doc.insertText(smart.paragraphId, smart.from, item);
      return { paragraphId: smart.paragraphId, offset: smart.from + item.length };
    });
    // A location ends in " - " and leads straight into the times of day.
    if (item.endsWith(" ")) this.refreshSmart(true);
    else this.closeSmart();
  }

  onSmartChange(listener: () => void): () => void {
    this.smartListeners.add(listener);
    return () => this.smartListeners.delete(listener);
  }

  private emitSmart(): void {
    for (const listener of this.smartListeners) listener();
  }

  // Decorations.

  /** An empty script shows what a scene heading looks like in its first, empty heading. */
  private withPlaceholder(doc: PMNode): DecorationSet {
    const first = doc.firstChild;
    if (doc.childCount !== 1 || !first || first.type !== schema.nodes.paragraph || first.content.size || first.attrs.type !== "sceneHeading") {
      return this.decorations;
    }
    return this.decorations.add(doc, [Decoration.node(0, first.nodeSize, { class: "editor-placeholder", "data-placeholder": PLACEHOLDER })]);
  }

  private click(pos: number): boolean {
    const [hit] = this.decorations.find(pos, pos, (spec) => typeof spec.onClick === "function");
    if (hit) (hit.spec.onClick as () => void)();
    return false;
  }

  private replaceDecorations(source: string, decorations: Decoration[]): void {
    const old = this.decorations.find(undefined, undefined, (spec) => spec.source === source);
    this.decorations = this.decorations.remove(old).add(this.view.state.doc, decorations);
    this.view.updateState(this.view.state);
  }

  setDecorations(source: string, list: Highlight[]): void {
    const doc = this.view.state.doc;
    const map = this.positionMap(doc);
    const decorations: Decoration[] = [];
    for (const item of list) {
      const start = map.get(item.paragraphId);
      if (start === undefined) continue;
      const node = doc.nodeAt(start)!;
      const attrs = { class: item.className, ...(item.title ? { title: item.title } : {}) };
      const spec = { source, onClick: item.onClick };
      if (item.from === undefined || item.to === undefined) {
        decorations.push(Decoration.node(start, start + node.nodeSize, attrs, spec));
        continue;
      }
      const size = node.content.size;
      const a = start + 1 + Math.max(0, Math.min(item.from, size)), b = start + 1 + Math.max(0, Math.min(item.to, size));
      if (b > a) decorations.push(Decoration.inline(a, b, attrs, spec));
    }
    this.replaceDecorations(source, decorations);
  }

  setRemoteCursors(cursors: RemoteCursor[]): void {
    const doc = this.view.state.doc;
    const decorations: Decoration[] = [];
    for (const cursor of cursors) {
      const anchor = this.pmPosition(doc, cursor.anchor), head = this.pmPosition(doc, cursor.head);
      if (anchor === null || head === null) continue;
      const color = SAFE_COLOR.test(cursor.color) ? cursor.color : "#8b857b";
      decorations.push(Decoration.widget(head, () => remoteCaret(cursor.name, color), {
        side: 1, key: `cursor-${cursor.clientId}-${color}-${cursor.name}`, source: CURSOR_SOURCE, ignoreSelection: true,
      }));
      if (anchor !== head) {
        decorations.push(Decoration.inline(Math.min(anchor, head), Math.max(anchor, head), {
          class: "editor-remote-selection", style: `background-color: color-mix(in srgb, ${color} 24%, transparent)`,
        }, { source: CURSOR_SOURCE }));
      }
    }
    this.replaceDecorations(CURSOR_SOURCE, decorations);
  }

  setPageBreaks(breaks: PageBreakMark[]): void {
    // Widgets follow edits through ProseMirror transaction mapping. Skip a full decoration update when
    // pagination reports identical paragraph-relative boundaries, even if the script changed elsewhere.
    const snapshot = JSON.stringify(breaks);
    if (snapshot === this.pageBreakSnapshot) return;
    this.pageBreakSnapshot = snapshot;
    const doc = this.view.state.doc;
    const map = this.positionMap(doc);
    const decorations: Decoration[] = [];
    for (const mark of breaks) {
      const start = map.get(mark.paragraphId);
      if (start === undefined) continue;
      const node = doc.nodeAt(start)!;
      const inline = mark.offset > 0 && mark.offset < node.content.size;
      const $start = doc.resolve(start);
      // A break before a paragraph in a dual block goes above the whole block.
      const pos = inline ? start + 1 + mark.offset : $start.depth > 0 ? $start.before(1) : start;
      const key = `page-${mark.pageNumber}-${mark.more ? 1 : 0}-${mark.contd ?? ""}-${inline ? node.attrs.type : "block"}`;
      decorations.push(Decoration.widget(pos, () => pageBreak(mark, inline), { side: -1, key, source: PAGE_SOURCE, ignoreSelection: true }));
    }
    this.replaceDecorations(PAGE_SOURCE, decorations);
  }

  // The bridge.

  focus(): void {
    this.view.focus();
  }

  getSelection(): Selection | null {
    const { doc, selection } = this.view.state;
    const anchor = this.textPosition(doc, selection.anchor, selection.anchor <= selection.head ? 1 : -1);
    const head = this.textPosition(doc, selection.head, selection.head < selection.anchor ? 1 : -1);
    return anchor && head ? { anchor, head } : null;
  }

  setSelection(anchor: Position, head: Position = anchor): void {
    this.select({ anchor, head });
  }

  revealParagraph(paragraphId: string, options: { select?: boolean; offset?: number; ifNeeded?: boolean } = {}): void {
    if (options.select) this.setSelection({ paragraphId, offset: options.offset ?? 0 });
    const start = this.positionMap(this.view.state.doc).get(paragraphId);
    if (start === undefined) return;
    if (options.ifNeeded) {
      const scroll = this.view.dom.closest(".editor-scroll");
      if (scroll) {
        const rect = scroll.getBoundingClientRect(), node = this.view.state.doc.nodeAt(start)!;
        const at = this.view.coordsAtPos(start + 1 + Math.max(0, Math.min(options.offset ?? 0, node.content.size)));
        if (at.top < rect.top || at.bottom > rect.bottom) scroll.scrollTop += at.top - rect.top - rect.height / 2;
        if (at.left < rect.left || at.right > rect.right) scroll.scrollLeft += at.left - rect.left - rect.width / 2;
        return;
      }
    }
    const dom = this.view.nodeDOM(start);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center" });
  }

  currentParagraphId(): string | null {
    const { $head } = this.view.state.selection;
    return $head.parent.type === schema.nodes.paragraph ? $head.parent.attrs.id : null;
  }

  currentElementType(): ElementType | null {
    const { $head } = this.view.state.selection;
    return $head.parent.type === schema.nodes.paragraph ? $head.parent.attrs.type : null;
  }

  setElementType(type: ElementType): void {
    const range = this.range();
    if (!range) return;
    const selection = this.getSelection()!;
    const shifts = new Map<string, number>();
    this.change((doc) => {
      for (const { id, paragraph } of this.pieces(range)) {
        if (!range.collapsed && id === range.to.paragraphId && range.to.offset === 0 && id !== range.from.paragraphId) continue;
        if (paragraph.type === type) continue;
        const text = plainText(paragraph.runs);
        if (type === "parenthetical" && text.trim()) {
          if (!text.endsWith(")")) doc.insertText(id, text.length, ")");
          if (!text.startsWith("(")) (doc.insertText(id, 0, "(", {}), shifts.set(id, 1));
        } else if (paragraph.type === "parenthetical" && unwrapParenthetical(text) !== text) {
          doc.deleteText(id, text.length - 1, 1);
          doc.deleteText(id, 0, 1);
          shifts.set(id, -1);
        }
        doc.setType(id, type);
      }
      const shift = (at: Position) => ({ paragraphId: at.paragraphId, offset: Math.max(0, at.offset + (shifts.get(at.paragraphId) ?? 0)) });
      return { anchor: shift(selection.anchor), head: shift(selection.head) };
    });
    this.emitSelection();
  }

  toggleMark(mark: Mark): void {
    const range = this.range();
    if (!range || this.session.readOnly) return;
    if (range.collapsed) {
      const current = this.storedMarks ?? this.marksAt(range.from);
      this.storedMarks = { ...current, [mark]: !current[mark] };
      this.emitSelection();
      return;
    }
    const pieces = this.pieces(range).filter((piece) => piece.to > piece.from);
    const all = covers(pieces, mark);
    const selection = this.getSelection()!;
    this.change((doc) => {
      for (const piece of pieces) doc.format(piece.id, piece.from, piece.to - piece.from, { [mark]: !all });
      return selection;
    });
  }

  activeMarks(): Marks {
    const range = this.range();
    if (!range) return {};
    if (range.collapsed) {
      const marks = this.storedMarks ?? this.marksAt(range.from);
      return Object.fromEntries(MARKS.filter((mark) => marks[mark]).map((mark) => [mark, true]));
    }
    const pieces = this.pieces(range).filter((piece) => piece.to > piece.from);
    if (!pieces.length) return {};
    return Object.fromEntries(MARKS.filter((mark) => covers(pieces, mark)).map((mark) => [mark, true]));
  }

  /** The marks typing at a position would continue. */
  marksAt(at: TextPosition): Marks {
    const paragraph = this.session.doc.paragraphs()[this.session.doc.indexOf(at.paragraphId)];
    const marks: Marks = {};
    if (!paragraph) return marks;
    let pos = 0;
    for (const run of paragraph.runs) {
      const end = pos + run.text.length;
      if (at.offset > pos && at.offset <= end) {
        for (const mark of MARKS) if (run[mark]) marks[mark] = true;
        break;
      }
      pos = end;
    }
    return marks;
  }

  insertParagraphs(paragraphs: NewParagraph[], at?: Position): string[] {
    const list: Paragraph[] = paragraphs.map((p) => ({ id: "", type: p.type, runs: p.runs ?? (p.text ? [{ text: p.text }] : []) }));
    if (!list.length) return [];
    let ids: string[] = [];
    const after = this.currentParagraphId() ?? this.session.doc.paragraphs().at(-1)!.id;
    this.change((doc) => {
      if (at) ids = doc.insertParagraphsAt(at, list);
      else {
        let index = doc.indexOf(after) + 1;
        ids = list.map((p) => doc.insertParagraph(index++, { type: p.type, runs: p.runs }));
      }
      const last = ids.at(-1)!;
      return { paragraphId: last, offset: plainText(doc.paragraphs()[doc.indexOf(last)]!.runs).length };
    });
    return ids;
  }

  /** A replacement keeps the replaced text's formatting, and is its own undo step (not merged with recent typing). */
  replaceText(paragraphId: string, from: number, to: number, text: string): void {
    replaceInDocument(this.session, paragraphId, from, to, text);
  }

  deleteParagraphs(paragraphIds: readonly string[]): void {
    deleteInDocument(this.session, paragraphIds);
  }

  onSelectionChange(listener: (selection: Selection | null) => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  onPlainTextPaste(listener: (text: string) => boolean): () => void {
    this.plainTextPasteListeners.add(listener);
    return () => this.plainTextPasteListeners.delete(listener);
  }

  private emitSelection(): void {
    // Typing, moving the caret or accepting a suggestion all end it.
    this.clearGhost();
    if (!this.selectionListeners.size) return;
    const selection = this.getSelection();
    for (const listener of this.selectionListeners) listener(selection);
  }
}

/** Every character in the pieces has the mark. */
function covers(pieces: { from: number; to: number; paragraph: Paragraph }[], mark: Mark): boolean {
  return pieces.every((piece) => {
    let at = 0;
    return piece.paragraph.runs.every((run) => {
      const start = at;
      at += run.text.length;
      return at <= piece.from || start >= piece.to || !!run[mark];
    });
  });
}

function ghostWidget(ghost: GhostText): HTMLElement {
  const span = document.createElement("span");
  span.className = ghost.pending ? "editor-ghost editor-ghost-pending" : "editor-ghost";
  span.contentEditable = "false";
  // Not script text; the feature that shows it announces it separately.
  span.setAttribute("aria-hidden", "true");
  span.textContent = ghost.pending ? " …" : ghost.text;
  return span;
}

function remoteCaret(name: string, color: string): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "editor-remote-caret";
  caret.style.borderColor = color;
  const label = document.createElement("span");
  label.className = "editor-remote-label";
  label.style.backgroundColor = color;
  label.textContent = name;
  caret.append(label);
  return caret;
}

function pageBreak(mark: PageBreakMark, inline: boolean): HTMLElement {
  const root = document.createElement("span");
  root.className = `editor-pagebreak${inline ? " editor-pagebreak-inline" : ""}`;
  root.contentEditable = "false";
  const part = (className: string, text = "") => {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = text;
    root.append(element);
  };
  if (mark.more) part("editor-pagebreak-more", "(MORE)");
  part("editor-pagebreak-end");
  part("editor-pagebreak-gap");
  part("editor-pagebreak-number", `${mark.pageNumber}.`);
  if (mark.contd) part("editor-pagebreak-contd", mark.contd);
  return root;
}
