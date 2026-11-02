// The Script view: a sheet of paper drawn with the script's own geometry (its FDX element settings and page
// margins, and the paper size chosen for printing, as printing resolves them), the find bar and the SmartType
// popup. The ProseMirror view inside is owned by an EditorController.
import { MARKS, resolveLayout, plainText, type ElementType, type FdxDocumentExtras, type Mark, type Marks, type Pagination } from "@screenplay/engine";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type RefObject } from "react";

import { app } from "../../core/app.ts";
import type { DocumentSession } from "../../core/session.ts";
import type { Selection } from "../../core/editor-bridge.ts";
import { useDocVersion, useEditor, useSession, useSessionState, useSetting } from "../../core/hooks.ts";
import { PageRoomContext } from "../../shell/PageRoomContext.ts";
import { fitPageZoom, readablePageRoom } from "../../shell/page-room.ts";
import { formatAccelerator } from "../../shell/Shell.tsx";
import { SETTINGS, printOptions, readPrintSettings } from "../print/options.ts";
import { EditorController } from "./controller.ts";
import { find } from "./find.ts";
import type { SearchScope } from "./search-scope.ts";
import { ELEMENT_LABELS, ELEMENT_SHORTCUTS } from "./rules.ts";

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

type Layout = Pagination["layout"];

/**
 * Per-element CSS from a resolved layout: margins in inches from the paper edge, the first line's hang, blank
 * lines above, line spacing, caps, alignment and style.
 */
export function layoutCss(layout: Layout): string {
  const rules: string[] = [];
  for (const [type, element] of Object.entries(layout.elements) as [ElementType, Layout["elements"][ElementType]][]) {
    rules.push(`.editor-t-${type} {
      --editor-left: ${element.left};
      margin-left: calc(var(--editor-in) * ${element.left});
      width: calc(var(--editor-in) * ${element.right - element.left});
      margin-top: calc(var(--editor-line) * ${element.spaceBefore});
      text-align: ${element.align};
      ${element.firstIndent ? `text-indent: calc(var(--editor-in) * ${element.firstIndent});` : ""}
      ${element.spacing && element.spacing !== 1 ? `line-height: calc(var(--editor-line) * ${element.spacing});` : ""}
      ${element.caps ? "text-transform: uppercase;" : ""}
      ${element.bold ? "font-weight: bold;" : ""}
      ${element.italic ? "font-style: italic;" : ""}
      ${element.underline ? "text-decoration: underline;" : ""}
    }
    .editor-t-${type} > .editor-pagebreak-inline { margin-left: calc(var(--editor-in) * -${element.left}); text-indent: 0; }`);
  }
  return rules.join("\n");
}

/**
 * The open script's layout as printing resolves it, so the screen matches the printed page. Re-read when the FDX
 * data or the paper setting changes, not on every keystroke.
 */
function useScriptLayout(): Layout {
  const session = useSession();
  const fdx = useSyncExternalStore((onChange) => {
    const meta = session.doc.meta;
    const observer = (event: { keysChanged: Set<string> }) => event.keysChanged.has("fdx") && onChange();
    meta.observe(observer);
    return () => meta.unobserve(observer);
  }, () => session.doc.meta.get("fdx") as FdxDocumentExtras | undefined);
  const [paper] = useSetting(SETTINGS.paper, "letter");
  return useMemo(() => resolveLayout(printOptions({ titlePage: [], paragraphs: [], ...(fdx ? { fdx } : {}) }, readPrintSettings({ [SETTINGS.paper]: paper }))), [fdx, paper]);
}

const viewPositions = new WeakMap<DocumentSession, { selection: Selection | null; scrollTop: number }>();

export function ScriptView() {
  const mount = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom] = useSetting("editor.zoom", 1);
  const [zoomMode] = useSetting<"fit" | "fixed">("editor.zoomMode", "fit");
  const [typewriter] = useSetting("editor.typewriter", false);
  const layout = useScriptLayout();
  const css = useMemo(() => layoutCss(layout), [layout]);
  const fit = useFitZoom(scroller, layout.page.width, zoomMode === "fit");
  const [controller, setController] = useState<EditorController | null>(null);

  useEffect(() => {
    const editor = new EditorController(mount.current!, app.session, {
      // Handle cross-feature shortcuts before ProseMirror consumes modified Enter/Tab.
      commands: () => app.commands,
    });
    setController(editor);
    app.setEditor(editor);
    const saved = viewPositions.get(editor.session);
    if (saved?.selection && editor.session.doc.has(saved.selection.anchor.paragraphId) && editor.session.doc.has(saved.selection.head.paragraphId)) {
      editor.setSelection(saved.selection.anchor, saved.selection.head);
    }
    editor.focus();
    const restore = requestAnimationFrame(() => { if (saved && scroller.current) scroller.current.scrollTop = saved.scrollTop; });
    const scrollElement = scroller.current;
    return () => {
      cancelAnimationFrame(restore);
      viewPositions.set(editor.session, { selection: editor.getSelection(), scrollTop: scrollElement?.scrollTop ?? 0 });
      if (app.editor === editor) app.setEditor(null);
      editor.destroy();
    };
  }, []);

  useEffect(() => {
    if (find.state.open) find.refresh();
  }, [controller]);

  useEffect(() => {
    if (!controller || !typewriter) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scroll = scroller.current;
        if (!scroll || !controller.view.hasFocus()) return;
        const caret = controller.view.coordsAtPos(controller.view.state.selection.head);
        const desired = scroll.getBoundingClientRect().top + scroll.clientHeight * 0.45;
        if (Math.abs(caret.top - desired) > 2) scroll.scrollTop += caret.top - desired;
      });
    };
    const off = controller.onSelectionChange(follow);
    follow();
    return () => { off(); cancelAnimationFrame(frame); };
  }, [controller, typewriter]);

  const { readOnly } = useSessionState();
  const style = {
    // Fixed zoom is an explicit readability choice; fit mode alone follows sidebar/window width.
    "--editor-zoom": String(zoomMode === "fit" ? fit : zoom),
    "--editor-paper-width": String(layout.page.width),
    "--editor-paper-height": String(layout.page.height),
    "--editor-top": String(layout.page.top),
    "--editor-bottom": String(layout.page.bottom),
  } as CSSProperties;
  return (
    <div className="editor-view" style={style}>
      <style>{css}</style>
      <FindBar />
      {readOnly ? <div className="editor-banner" role="status">Read-only. You can follow this script but not change it.</div> : null}
      <FirstRunHint />
      <div ref={scroller} className={`editor-scroll ${typewriter ? "editor-typewriter" : ""}`} onMouseDown={(event) => {
        // Clicks on the desk around the paper put the caret back in the script.
        if (event.target === event.currentTarget) (event.preventDefault(), controller?.focus());
      }}>
        <div className="editor-sheet">
          <div ref={mount} className="editor-mount" />
        </div>
      </div>
      {controller ? <SmartTypePopup controller={controller} /> : null}
    </div>
  );
}

/** Fit the scrolling area, allowing horizontal scrolling below the readable width. */
function useFitZoom(scroller: RefObject<HTMLDivElement | null>, paperWidth: number, enabled: boolean): number {
  const [fit, setFit] = useState(1);
  const reportPageRoom = useContext(PageRoomContext);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const gutters = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      reportPageRoom(enabled ? readablePageRoom(paperWidth, gutters) : 0);
      setFit(fitPageZoom(element.clientWidth - gutters, paperWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); reportPageRoom(0); };
  }, [scroller, paperWidth, enabled, reportPageRoom]);
  return fit;
}

/** True while the open script is one empty paragraph: a new script nobody has typed in. */
function useEmptyScript(): boolean {
  useDocVersion();
  const paragraphs = app.session.doc.paragraphs();
  return paragraphs.length === 1 && !plainText(paragraphs[0]!.runs);
}

/** A first-run line about the two keys a screenplay is written with. It goes for good once the writer starts typing. */
function FirstRunHint() {
  const [typed, setTyped] = useState(false);
  const { readOnly } = useSessionState();
  // Once gone, nothing here follows the document any more, so typing on a long script costs nothing.
  return typed || readOnly ? null : <EmptyScriptHint onTyped={() => setTyped(true)} />;
}

function EmptyScriptHint({ onTyped }: { onTyped(): void }) {
  const empty = useEmptyScript();
  useEffect(() => {
    if (!empty) onTyped();
  }, [empty, onTyped]);
  if (!empty) return null;
  return (
    <section className="editor-welcome" aria-label="Start writing">
      <div><h2>Start on the page.</h2><p>Type a scene heading below, or bring in a draft.</p><p>Dictating rough text? Select it and use <kbd>⌘⇧Return</kbd> to Format Draft.</p></div>
      <div className="editor-welcome-actions"><button className="button" onClick={() => void app.runCommand("file.open")}>Open script…</button><button className="button" onClick={() => void app.runCommand("workspace.recentPinned")}>Recent / Pinned</button></div>
    </section>
  );
}

function SmartTypePopup({ controller }: { controller: EditorController }) {
  const smart = useSyncExternalStore((listener) => controller.onSmartChange(listener), () => controller.smart);
  // Keep focus in the script. The active-descendant relationship lets VoiceOver discover the currently
  // highlighted suggestion without moving focus away from the typing position.
  useEffect(() => {
    const editor = controller.view.dom;
    if (smart) {
      editor.setAttribute("aria-autocomplete", "list");
      editor.setAttribute("aria-haspopup", "listbox");
      editor.setAttribute("aria-expanded", "true");
      editor.setAttribute("aria-controls", "editor-smarttype-options");
      editor.setAttribute("aria-activedescendant", `editor-smarttype-item-${smart.index}`);
    } else {
      for (const name of ["aria-autocomplete", "aria-haspopup", "aria-expanded", "aria-controls", "aria-activedescendant"]) editor.removeAttribute(name);
    }
    return () => {
      for (const name of ["aria-expanded", "aria-controls", "aria-activedescendant"]) editor.removeAttribute(name);
    };
  }, [controller, smart]);
  if (!smart) return null;
  return (
    <ul id="editor-smarttype-options" className="editor-smarttype" role="listbox" aria-label="Suggestions" style={{ left: smart.left, top: smart.top + 4 }}>
      {smart.items.map((item, i) => (
        <li key={item} id={`editor-smarttype-item-${i}`} role="option" aria-selected={i === smart.index} className={i === smart.index ? "on" : ""}
          onMouseDown={(event) => (event.preventDefault(), controller.acceptSmart(i))}>{item}</li>
      ))}
    </ul>
  );
}

function useFind() {
  return useSyncExternalStore((listener) => find.subscribe(listener), () => find.state);
}

function FindBar() {
  const state = useFind();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.open) input.current?.select();
  }, [state.open, state.focusRequest]);
  if (!state.open) return null;
  const count = state.matches.length;
  const position = state.current >= 0 ? `${state.current + 1} of ${count}` : `${count} match${count === 1 ? "" : "es"}`;
  const keys = (event: KeyboardEvent, enter: () => void) => {
    if (event.key === "Escape") (event.preventDefault(), find.close());
    else if (event.key === "Enter") (event.preventDefault(), event.shiftKey ? find.next(true) : enter());
  };
  return (
    <div className="editor-find" role="search">
      <div className="editor-find-row">
        <input ref={input} className="input editor-find-input" placeholder="Find" aria-label="Find" value={state.query}
          onChange={(event) => find.update({ query: event.target.value })} onKeyDown={(event) => keys(event, () => find.next())} />
        <span className="editor-find-count">{state.query ? position : ""}</span>
        <button className="icon-button" title="Previous match" aria-label="Previous match" onClick={() => find.next(true)}>‹</button>
        <button className="icon-button" title="Next match" aria-label="Next match" onClick={() => find.next()}>›</button>
        <label className="editor-find-option"><input type="checkbox" checked={state.matchCase}
          onChange={(event) => find.update({ matchCase: event.target.checked })} />Match case</label>
        <label className="editor-find-option"><input type="checkbox" checked={state.wholeWord}
          onChange={(event) => find.update({ wholeWord: event.target.checked })} />Whole word</label>
        <button className="icon-button" title={state.replacing ? "Hide replace" : "Show replace"} onClick={() => find.update({ replacing: !state.replacing })}>
          Replace…
        </button>
        <button className="icon-button" aria-label="Close find" title="Close" onClick={() => find.close()}>×</button>
      </div>
      <div className="editor-find-row">
        <label>Search in <select aria-label="Search scope" value={state.scope} onChange={(e) => find.update({ scope: e.target.value as SearchScope })}>
          <option value="all">Whole script</option><option value="scene">Scene where search opened</option><option value="selection">Original selection</option><option value="character">One character's dialogue</option><option value="dialogue">All dialogue</option><option value="action">Action only</option>
        </select></label>
        {state.scope === "character" && <input aria-label="Search character" placeholder="Character name" value={state.character} onChange={(e) => find.update({ character: e.target.value })}/>}
        <small>Scope stays pinned while you move between matches.</small>
      </div>
      {state.replacing ? (
        <div className="editor-find-row">
          <input className="input editor-find-input" placeholder="Replace with" aria-label="Replace with" value={state.replacement}
            onChange={(event) => find.update({ replacement: event.target.value })} onKeyDown={(event) => keys(event, () => find.replace())} />
          <button className="button" disabled={!count} onClick={() => find.replace()}>Replace</button>
          <button className="button" disabled={!count} onClick={() => find.replaceAll()}>Replace All</button>
          <details className="replace-preview"><summary>Preview {count} replacements</summary><ul>{state.matches.slice(0,40).map((match,i) => <li key={`${match.paragraphId}:${match.from}:${i}`}>{app.session.doc.has(match.paragraphId) ? plainText(app.session.doc.paragraph(match.paragraphId).runs).slice(Math.max(0,match.from-35),match.to+35) : "Source removed"} → {state.replacement}</li>)}</ul>{count > 40 && <p>Showing the first 40 of {count}; Replace All applies to every current match.</p>}</details>
        </div>
      ) : null}
    </div>
  );
}

/** The element type at the caret, updated as the caret moves and the script changes. */
export function useElementType(): ElementType | null {
  const editor = useEditor();
  const [type, setType] = useState<ElementType | null>(() => editor?.currentElementType() ?? null);
  useEffect(() => {
    if (!editor) return setType(null);
    const update = () => setType(editor.currentElementType());
    update();
    return editor.onSelectionChange(update);
  }, [editor]);
  return type;
}

export function ElementPicker() {
  const editor = useEditor();
  const type = useElementType();
  const { readOnly } = useSessionState();
  if (!editor) return null;
  return (
    <select className="editor-element-picker" aria-label="Element" title="Screenplay element (see Keyboard Shortcuts for your current bindings)" disabled={readOnly} value={type ?? ""}
      onMouseDown={(event) => event.stopPropagation()}
      onChange={(event) => {
        editor.setElementType(event.target.value as ElementType);
        editor.focus();
      }}>
      {type === null ? <option value="">Element</option> : null}
      {(Object.keys(ELEMENT_LABELS) as ElementType[]).map((value) => <option key={value} value={value}>{ELEMENT_LABELS[value]}{app.commands.find((c) => c.id === `editor.element.${value}`)?.accelerator ? `  ${formatAccelerator(app.commands.find((c) => c.id === `editor.element.${value}`)!.accelerator!)}` : ""}</option>)}
    </select>
  );
}

const MARK_BUTTONS: { mark: Mark; label: string; letter: string; command: string }[] = [
  { mark: "bold", label: "Bold", letter: "B", command: "editor.bold" },
  { mark: "italic", label: "Italic", letter: "I", command: "editor.italic" },
  { mark: "underline", label: "Underline", letter: "U", command: "editor.underline" },
];

/** Bold, italic and underline at the caret, as the editor reports them. Empty while no editor is mounted. */
export function useActiveMarks(): Marks {
  const editor = useEditor();
  const [marks, setMarks] = useState<Marks>({});
  useEffect(() => {
    if (!editor) return setMarks({});
    // Stand-in editors in tests may not implement activeMarks. Same marks keep the same object: no re-render per key.
    const key = (marks: Marks) => MARKS.map((mark) => (marks[mark] ? 1 : 0)).join("");
    const read = () => {
      const next = editor.activeMarks?.() ?? {};
      setMarks((current) => (key(current) === key(next) ? current : next));
    };
    read();
    return editor.onSelectionChange(read);
  }, [editor]);
  return marks;
}

/** B, I and U in the title bar: pressed when the caret's text has the mark. */
export function MarkButtons() {
  const editor = useEditor();
  const marks = useActiveMarks();
  const { readOnly } = useSessionState();
  if (!editor) return null;
  return (
    <div className="editor-marks" role="group" aria-label="Text style">
      {MARK_BUTTONS.map(({ mark, label, letter, command }) => {
        const accelerator = app.commands.find((c) => c.id === command)?.accelerator;
        return (
          <button key={mark} className={`icon-button editor-mark editor-mark-${mark} ${marks[mark] ? "on" : ""}`} aria-pressed={!!marks[mark]}
            aria-label={label} title={accelerator ? `${label} (${formatAccelerator(accelerator)})` : label} disabled={readOnly}
            // Keep the caret in the script: a click must not move focus away from the editor.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void app.runCommand(command)}>{letter}</button>
        );
      })}
    </div>
  );
}

export function ElementStatus() {
  const type = useElementType();
  // Nothing at all when there is no element, so the status bar draws no separator for an empty slot.
  return type ? <span className="editor-status">{ELEMENT_LABELS[type]}</span> : null;
}
