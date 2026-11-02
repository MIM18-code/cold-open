// How features talk to the script editor without depending on its internals. The editor feature implements
// this and registers it with app.setEditor(); everything else reads app.editor (null while no editor is mounted).
import type { ElementType, Mark, Marks, Run } from "@screenplay/engine";

/** A caret position: a paragraph and a character offset into its text. */
export interface Position {
  paragraphId: string;
  offset: number;
}

export interface Selection {
  anchor: Position;
  head: Position;
}

/**
 * A highlight drawn over the script. Inline when from/to are given, otherwise the whole paragraph.
 * Each source (proofreading, find, revisions, compare) owns its own set and replaces it wholesale.
 */
export interface Decoration {
  paragraphId: string;
  from?: number;
  to?: number;
  /** CSS class added to the range or paragraph. Features style their own classes. */
  className: string;
  /** Tooltip. */
  title?: string;
  /** Called when the writer clicks the decorated text. */
  onClick?: () => void;
}

/** Another writer's caret and selection, from the co-writing awareness state. */
export interface RemoteCursor {
  clientId: number;
  name: string;
  color: string;
  anchor: Position;
  head: Position;
}

/** A page break the editor should draw: the page that starts at this paragraph (and line within it, for split paragraphs). */
export interface PageBreakMark {
  paragraphId: string;
  /** Character offset in the paragraph where the new page starts; 0 for a break before the paragraph. */
  offset: number;
  pageNumber: string;
  /** Text to show at the bottom of the previous page and top of the new one, such as (MORE) and (CONT'D). */
  more?: boolean;
  contd?: string;
}

/** Suggested text drawn in grey after a caret position. It is not part of the script until accepted. */
export interface GhostText extends Position {
  text: string;
  /** Show a placeholder while the suggestion is on its way. */
  pending?: boolean;
  /** Called when the editor clears the suggestion itself: Esc, typing, moving the caret, or accepting it. */
  onDismiss?: () => void;
}

export interface NewParagraph {
  type: ElementType;
  text?: string;
  runs?: Run[];
}

export interface EditorBridge {
  focus(): void;
  getSelection(): Selection | null;
  setSelection(anchor: Position, head?: Position): void;
  /** Scroll a paragraph into view, optionally placing the caret at its start. */
  revealParagraph(paragraphId: string, options?: { select?: boolean; offset?: number; ifNeeded?: boolean }): void;
  /** The paragraph holding the caret. */
  currentParagraphId(): string | null;
  /** The element type at the caret, for toolbars. */
  currentElementType(): ElementType | null;
  setElementType(type: ElementType): void;
  toggleMark(mark: Mark): void;
  /**
   * Bold, italic and underline at the caret, for toolbars: what typing would continue (including a mark just
   * toggled with no text selected), or the marks that cover the whole selection. onSelectionChange fires when
   * these change, so a toolbar reads them in its selection listener.
   */
  activeMarks(): Marks;
  /** Insert paragraphs after the caret's paragraph (or at a position), as one undoable edit. Returns their IDs. */
  insertParagraphs(paragraphs: NewParagraph[], at?: Position): string[];
  /** Replace text in one paragraph, as one undoable edit (proofreading fixes, find and replace). */
  replaceText(paragraphId: string, from: number, to: number, text: string): void;
  /** Delete whole paragraphs as one undoable edit. */
  deleteParagraphs(paragraphIds: readonly string[]): void;
  setDecorations(source: string, decorations: Decoration[]): void;
  setRemoteCursors(cursors: RemoteCursor[]): void;
  /** Show or clear a suggestion. → accepts it while the caret sits at its position, as one undoable edit. */
  setGhostText(ghost: GhostText | null): void;
  setPageBreaks(breaks: PageBreakMark[]): void;
  /** The caret or selection moved, the text under it changed, or a mark was toggled at the caret. */
  onSelectionChange(listener: (selection: Selection | null) => void): () => void;
}
