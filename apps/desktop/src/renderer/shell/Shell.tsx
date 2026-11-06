// The document chrome stays separate from the writing tools, so a visual redesign can reuse either.
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { app, type Command } from "../core/app.ts";
import { useApp, useSessionState, useSetting } from "../core/hooks.ts";
import { desktop } from "../core/platform.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { PanelTabs } from "./PanelTabs.tsx";
import { PageRoomContext } from "./PageRoomContext.ts";
import { needsSceneCollapse } from "./page-room.ts";

export function Shell() {
  const views = useApp((a) => a.views);
  const view = useApp((a) => a.ui.view);
  const focus = useApp((a) => !!a.ui.focusMode);
  const blocked = useApp((a) => !!a.ui.modal || a.ui.paletteOpen);
  const left = useApp((a) => a.ui.leftPanel);
  const right = useApp((a) => a.ui.rightPanel);
  const panels = useApp((a) => a.panels);
  const body = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(window.innerWidth);
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(332);
  const [pageRoom, setPageRoom] = useState(0);
  const [forceScenes, setForceScenes] = useState(false);
  const limitedRoom = !!right && view === "script" && needsSceneCollapse(
    bodyWidth, Math.min(leftWidth, bodyWidth * 0.34), Math.min(rightWidth, bodyWidth * 0.34), pageRoom,
  );
  const narrow = limitedRoom && !focus;
  const collapsed = !!left && narrow && !forceScenes;
  useEffect(() => {
    const observer = new ResizeObserver(() => setBodyWidth(body.current!.clientWidth));
    observer.observe(body.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!narrow) setForceScenes(false); }, [narrow]);
  const toggleScenes = () => {
    app.setFocusMode(false);
    if (collapsed || !left || focus) {
      setForceScenes(limitedRoom);
      if (!left) app.togglePanel(panels.find((panel) => panel.side === "left")?.id ?? "", true);
    } else {
      setForceScenes(false);
      app.togglePanel(left, false);
    }
  };
  const active = views.find((v) => v.id === view) ?? views[0];
  const ActiveView = active?.component;
  return (
    <div className="shell" data-focus={focus}>
      <div className="shell-workspace" inert={blocked}>
        <TitleBar leftVisible={!!left && !collapsed && !focus} toggleScenes={toggleScenes} />
        <WritingBar />
        <div className="shell-body" ref={body}>
          <SidePanel side="left" collapsed={collapsed} onWidthChange={setLeftWidth} />
          <main className="shell-main" id="main-view" role="region" aria-label={active?.title}>
            <PageRoomContext.Provider value={setPageRoom}>
              {ActiveView ? <ErrorBoundary key={active.id} name={active.title}><ActiveView /></ErrorBoundary>
                : <div className="shell-empty">No views are installed.</div>}
            </PageRoomContext.Provider>
          </main>
          <SidePanel side="right" onWidthChange={setRightWidth} />
        </div>
        <StatusBar />
      </div>
      <ModalHost />
      <CommandPalette />
      <Toasts />
    </div>
  );
}

function TitleBar({ leftVisible, toggleScenes }: { leftVisible: boolean; toggleScenes: () => void }) {
  const { name, dirty, readOnly, path } = useSessionState();
  const panels = useApp((a) => a.panels);
  const right = useApp((a) => a.ui.rightPanel);
  const focus = useApp((a) => !!a.ui.focusMode);
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <button className={`icon-button ${leftVisible ? "on" : ""}`} aria-label="Toggle left sidebar"
          aria-pressed={leftVisible} title={withShortcut("Scenes and navigation", "workspace.leftSidebar")} onClick={toggleScenes}>
          <SidebarIcon side="left" />
        </button>
        <span className="titlebar-name" title={name}>{name}{dirty ? <span className="titlebar-dot" title="Unsaved changes">•</span> : null}</span>
        {readOnly ? <span className="titlebar-state">Read-only</span> : <button className="save-state" title={dirty || !path ? `${withShortcut("Save the current draft", "file.save")}. Recovery backups are separate from saving.` : "Saved to disk"} onClick={() => void app.runCommand("file.save")}>{dirty ? "Unsaved" : path ? "Saved" : "Not saved"}</button>}
      </div>
      <WritingNavigation />
      <div className="titlebar-right">
        <button
          aria-pressed={right === "tableRead" && !focus}
          className={`icon-button header-tool ${right === "tableRead" && !focus ? "on" : ""}`}
          onClick={() => void app.runCommand("tableRead.open")}
          title={withShortcut("Table Read", "tableRead.open")}
        >Listen</button>
        <button className="icon-button header-tool" onClick={() => void app.runCommand("reports.open")} title="Script reports and exports">Reports</button>
        <button className="command-trigger" title={`Find a command (${formatAccelerator("CmdOrCtrl+K")})`} aria-label={`Commands ${formatAccelerator("CmdOrCtrl+K")}`} onClick={() => app.setPalette(true)}>
          <span>Commands</span><kbd>{formatAccelerator("CmdOrCtrl+K")}</kbd>
        </button>
        <button className="icon-button" aria-label="Settings" title={withShortcut("Settings", "workspace.settings")} onClick={() => app.openModal("workspace.settings")}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12M5 2v4M11 6v4M6 10v4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>
        <span className="titlebar-sep" aria-hidden="true" />
        <button className={`icon-button ${right && !focus ? "on" : ""}`} aria-label="Toggle right sidebar" aria-pressed={!!right && !focus} title={withShortcut("Writing assistants", "workspace.rightSidebar")}
          onClick={() => { app.setFocusMode(false); app.togglePanel(right ?? panels.find((p) => p.side === "right")?.id ?? ""); }}>
          <SidebarIcon side="right" />
        </button>
      </div>
    </header>
  );
}

function WritingNavigation() {
  const views = useApp((a) => a.views), current = useApp((a) => a.ui.view);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => (ref.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
      ?? ref.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus());
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); };
  }, [open]);
  const plan = views.filter((v) => v.id !== "script" && v.id !== "brainstorm");
  const planning = plan.find((v) => v.id === current);
  const brainstorm = views.some((v) => v.id === "brainstorm");
  return <nav className="writing-navigation" aria-label="Writing workspace">
    {brainstorm && <button className={`brainstorm-primary ${current === "brainstorm" ? "on" : ""}`} aria-current={current === "brainstorm" ? "page" : undefined}
      title="Type or dictate loose ideas as notes" onClick={() => { setOpen(false); app.setView("brainstorm"); }}>Brainstorm</button>}
    <button className={`write-primary ${current === "script" ? "on" : ""}`} aria-current={current === "script" ? "page" : undefined} onClick={() => { setOpen(false); app.setView("script"); }}>Write</button>
    <div className="planning-nav" ref={ref} onBlur={(e) => { if (open && !ref.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={(e) => {
      if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      // Tab leaves a menu: close it and let the key continue from the trigger to the next control.
      if (e.key === "Tab" && open && !e.shiftKey) { setOpen(false); trigger.current?.focus(); }
      if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault(); const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
        if (!buttons.length) return;
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
      <button ref={trigger} className={`plan-trigger ${planning ? "on" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{planning?.title ?? "Plan"}<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg></button>
      {open && <div className="planning-menu" role="menu" aria-label="Planning views">{plan.map((v) => <button key={v.id} role="menuitemradio" aria-checked={current === v.id} onClick={() => { setOpen(false); app.setView(v.id); trigger.current?.focus(); }}><strong>{v.title}</strong><small>{v.id === "cards" ? "Arrange scenes as index cards" : v.id === "storyMap" ? "Place structure points on the page timeline" : "See the shape of the story"}</small></button>)}</div>}
    </div>
  </nav>;
}

function WritingBar() {
  const toolbar = useApp((a) => a.toolbarItems);
  return <div className="writingbar" role="toolbar" aria-label="Writing tools">
    {toolbar.map((item) => <ErrorBoundary key={item.id} name={item.id}><item.component /></ErrorBoundary>)}
  </div>;
}

function SidebarIcon({ side }: { side: "left" | "right" }) {
  return <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
    <rect x="0.75" y="0.75" width="14.5" height="12.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <rect x={side === "left" ? 2.5 : 10} y="2.5" width="3.5" height="9" rx="1" fill="currentColor" />
  </svg>;
}

function SidePanel({ side, collapsed = false, onWidthChange }: {
  side: "left" | "right";
  collapsed?: boolean;
  onWidthChange: (width: number) => void;
}) {
  const panels = useApp((a) => a.panels.filter((p) => p.side === side));
  const current = useApp((a) => side === "left" ? a.ui.leftPanel : a.ui.rightPanel);
  const [stored, setStored] = useSetting(`workspace.${side}Width`, side === "left" ? 240 : 332);
  const [width, setWidth] = useState(stored);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => { onWidthChange(width); }, [width, onWidthChange]);
  useEffect(() => { setWidth(Math.max(180, Math.min(460, Number(stored) || 240))); }, [stored]);
  const resize = (value: number, save = false) => { const next = Math.max(180, Math.min(460, value)); setWidth(next); if (save) setStored(next); };
  const panel = panels.find((p) => p.id === current);
  if (!panel) return null;
  const Panel = panel.component;
  return <aside hidden={collapsed} className={`sidepanel sidepanel-${side}`} aria-label={`${side} sidebar`} style={{ width: `min(${width}px, 34vw)` }}>
    <div className={`panel-resize panel-resize-${side}`} role="separator" aria-label={`Resize ${side} sidebar`} aria-orientation="vertical" aria-valuemin={180} aria-valuemax={460} aria-valuenow={width} tabIndex={0}
      onDoubleClick={() => resize(side === "left" ? 240 : 332, true)}
      onKeyDown={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); resize(e.key === "Home" ? 180 : e.key === "End" ? 460 : width + (e.key === "ArrowRight" ? 12 : -12) * (side === "left" ? 1 : -1), true); } }}
      onPointerDown={(e) => { if (e.button !== 0) return; drag.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }}
      onPointerMove={(e) => { if (drag.current) resize(drag.current.width + (e.clientX - drag.current.x) * (side === "left" ? 1 : -1)); }}
      onPointerUp={(e) => { if (!drag.current) return; drag.current = null; setStored(width); e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { drag.current = null; setWidth(stored); }} />
    {panels.length > 1 ? <PanelTabs panels={panels} current={panel.id} side={side} />
      : <div className="sidepanel-title">{panel.title}</div>}
    <div className="sidepanel-body" id={`panel-${side}`} role="tabpanel" aria-label={panel.title}><ErrorBoundary key={panel.id} name={panel.title}><Panel /></ErrorBoundary></div>
  </aside>;
}

function StatusBar() {
  const items = useApp((a) => a.statusItems);
  return <footer className="statusbar">{items.map((item) => (
    <div className="statusbar-item" key={item.id}>
      <ErrorBoundary name={item.id}><item.component /></ErrorBoundary>
    </div>
  ))}</footer>;
}

/** Keep Tab inside a dialog; background chrome is inert while it is open. */
function useDialogFocus(ref: RefObject<HTMLDivElement | null>, open: boolean, close: () => void) {
  const onClose = useRef(close); onClose.current = close;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      if (ref.current?.contains(document.activeElement)) return;
      const focusable = ':is(input,textarea,select,button):not([disabled]):not([type="hidden"])';
      // The header's Close button comes first in the DOM; landing there means Return or Space dismisses the dialog.
      (ref.current?.querySelector<HTMLElement>(`.modal-body ${focusable}`) ?? ref.current?.querySelector<HTMLElement>(focusable))?.focus();
    });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose.current(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]') ?? []).filter((e) => e.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); ref.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", onKey, true); requestAnimationFrame(() => { if (previous?.isConnected && !previous.closest('[inert]')) previous.focus(); }); };
  }, [open, ref]);
}

/** Close on a click that both starts and ends on the backdrop, so dragging a text selection out of a field keeps the dialog. */
function useBackdropDismiss(close: () => void) {
  const pressed = useRef(false);
  return {
    onMouseDown: (event: ReactMouseEvent) => { pressed.current = event.target === event.currentTarget; },
    onClick: (event: ReactMouseEvent) => { if (pressed.current && event.target === event.currentTarget) close(); pressed.current = false; },
  };
}

function ModalHost() {
  const modal = useApp((a) => a.ui.modal);
  const defs = useApp((a) => a.modals);
  const def = modal && defs.find((m) => m.id === modal.id);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, !!def, () => app.closeModal());
  const dismiss = useBackdropDismiss(() => app.closeModal());
  if (!modal || !def) return null;
  const Body = def.component;
  const style = def.width === "wide" ? { width: "min(1200px, calc(100vw - 48px))" } : { width: `min(${def.width ?? 560}px, calc(100vw - 48px))` };
  return <div className="modal-backdrop" {...dismiss}>
    <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={def.title} tabIndex={-1} style={style}>
      <div className="modal-header"><h2>{def.title}</h2><button className="icon-button" aria-label="Close" onClick={() => app.closeModal()}>×</button></div>
      <div className="modal-body"><ErrorBoundary key={modal.id} name={def.title}><Body key={modal.id + JSON.stringify(modal.props ?? null)} close={() => app.closeModal()} props={modal.props} /></ErrorBoundary></div>
    </div>
  </div>;
}

function unavailableReason(command: Command): string {
  if (app.session.readOnly) return "This script is read-only.";
  if (!app.editor || app.ui.view !== "script") return "Open the Write view first.";
  if (command.id === "draftFormat.run") return "Close any active text field or wait for formatting to finish.";
  return "Unavailable in the current context.";
}
function CommandPalette() {
  const open = useApp((a) => a.ui.paletteOpen);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [hint, setHint] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Snapshot availability before palette input takes focus; commands continue to be rechecked on execution.
  // Unlike the old palette, disabled actions stay searchable and explain why they cannot run.
  const commands = useMemo(() => open ? app.commands.filter((c) => !c.hidden).map((command) =>
    ({ command, available: !command.enabled || command.enabled(app) })) : [], [open]);
  const matches = useMemo(() => commands.filter(({ command }) => `${command.menu ?? ""} ${command.label}`.toLowerCase().includes(query.trim().toLowerCase())), [commands, query]);
  const selected = Math.min(index, Math.max(0, matches.length - 1));
  useDialogFocus(ref, open, () => app.setPalette(false));
  const dismiss = useBackdropDismiss(() => app.setPalette(false));
  useEffect(() => { if (open) { setQuery(""); setIndex(0); setHint(""); input.current?.focus(); } }, [open]);
  useEffect(() => { list.current?.children[selected]?.scrollIntoView({ block: "nearest" }); }, [selected]);
  if (!open) return null;
  const choose = (item: (typeof matches)[number] | undefined) => {
    if (!item) return;
    if (!item.available) { setHint(unavailableReason(item.command)); return; }
    app.setPalette(false);
    requestAnimationFrame(() => { app.editor?.focus(); void app.runCommand(item.command.id); });
  };
  return <div className="modal-backdrop palette-backdrop" {...dismiss}>
    <div ref={ref} className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <input ref={input} value={query} placeholder="Type a command" aria-label="Command" role="combobox" aria-expanded="true" aria-controls="command-options" aria-activedescendant={matches.length ? `command-${selected}` : undefined} autoComplete="off"
        onChange={(event) => { setQuery(event.target.value); setIndex(0); setHint(""); }} onKeyDown={(event) => {
          if (event.isDefaultPrevented() || event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown") { event.preventDefault(); setIndex(Math.min(selected + 1, Math.max(0, matches.length - 1))); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setIndex(Math.max(selected - 1, 0)); }
          else if (event.key === "Enter") { event.preventDefault(); choose(matches[selected]); }
        }} />
      <ul ref={list} id="command-options" role="listbox" aria-label="Commands">
        {matches.map((item, i) => <li id={`command-${i}`} role="option" aria-selected={i === selected} aria-disabled={!item.available} key={item.command.id}
          className={`${i === selected ? "on" : ""} ${!item.available ? "palette-unavailable" : ""}`}
          onMouseEnter={() => setIndex(i)} onMouseDown={(event) => { event.preventDefault(); choose(item); }}>
          <span>{item.command.menu ? <span className="palette-menu">{item.command.menu} ›</span> : null}{item.command.label}{!item.available ? " · unavailable" : ""}</span>
          {item.command.accelerator ? <kbd>{formatAccelerator(item.command.accelerator)}</kbd> : null}
        </li>)}
        {!matches.length && <li className="palette-none" role="presentation">No matching command</li>}
      </ul>
      {hint && <p className="palette-reason" role="status">{hint}</p>}
    </div>
  </div>;
}

export function formatAccelerator(accelerator: string): string {
  const mac = desktop.platform === "darwin" || (desktop.platform === "browser" && typeof navigator !== "undefined" && navigator.platform.startsWith("Mac"));
  return mac ? accelerator.replace(/CmdOrCtrl|CommandOrControl|Command|Cmd/g, "⌘").replace(/Shift/g, "⇧").replace(/Alt|Option/g, "⌥").replace(/Ctrl|Control/g, "⌃").replace(/\+/g, "")
    : accelerator.replace(/CmdOrCtrl|CommandOrControl|Command|Cmd/g, "Ctrl").replace(/Option/g, "Alt");
}
function Toasts() {
  const toasts = useApp((a) => a.ui.toasts);
  const notices = toasts.filter((toast) => toast.kind !== "error"), errors = toasts.filter((toast) => toast.kind === "error");
  const item = (toast: (typeof toasts)[number]) => <div key={toast.id} className={`toast toast-${toast.kind}`}
    onMouseEnter={() => app.holdToast(toast.id, true)} onMouseLeave={() => app.holdToast(toast.id, false)}>
    <span className="toast-message">{toast.message}</span>
    <button className="toast-close" aria-label="Dismiss message" title="Dismiss" onClick={() => app.dismissToast(toast.id)}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    </button>
  </div>;
  // Errors interrupt the screen reader; other messages wait for a pause. Both stacks share the same spot on screen.
  return <div className="toasts">
    <div className="toast-stack" aria-live="assertive">{errors.map(item)}</div>
    <div className="toast-stack" aria-live="polite">{notices.map(item)}</div>
  </div>;
}

function withShortcut(label: string, commandId: string): string {
  const accelerator = app.commands.find((command) => command.id === commandId)?.accelerator;
  return accelerator ? `${label} (${formatAccelerator(accelerator)})` : label;
}
