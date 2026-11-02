import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { app, type PanelDef } from "../core/app.ts";
import { visiblePanelTabs } from "./panel-tabs.ts";

export function PanelTabs({ panels, current, side }: {
  panels: PanelDef[];
  current: string;
  side: "left" | "right";
}) {
  const root = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusSelection = useRef(false);
  const menuFromEnd = useRef(false);
  const [sizes, setSizes] = useState({ room: 0, widths: [] as number[], more: 0 });
  const [open, setOpen] = useState(false);
  const active = panels.findIndex((panel) => panel.id === current);
  const visible = sizes.widths.length === panels.length
    ? visiblePanelTabs(sizes.widths, active, sizes.room, sizes.more) : [active];
  const overflow = panels.filter((_, index) => !visible.includes(index));

  useLayoutEffect(() => {
    const container = root.current!;
    const labels = Array.from(measure.current!.children);
    const update = () => setSizes({
      room: container.clientWidth - 6,
      widths: labels.slice(0, -1).map((label) => label.getBoundingClientRect().width),
      more: labels.at(-1)!.getBoundingClientRect().width,
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    labels.forEach((label) => observer.observe(label));
    return () => observer.disconnect();
  }, [panels]);

  useEffect(() => {
    if (focusSelection.current) {
      root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
      focusSelection.current = false;
    }
  }, [current]);

  useEffect(() => { if (!overflow.length) setOpen(false); }, [overflow.length]);

  useEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[menuFromEnd.current ? items.length - 1 : 0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const choose = (id: string) => {
    focusSelection.current = id !== current;
    setOpen(false);
    app.togglePanel(id, true);
  };
  const tabKeys = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const at = visible.indexOf(active);
    const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1
      : (at + (event.key === "ArrowRight" ? 1 : -1) + visible.length) % visible.length;
    event.preventDefault();
    choose(panels[visible[next]!]!.id);
  };
  return <div className="panel-switcher" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <div className="panel-tab-measure" ref={measure} aria-hidden="true">
      {panels.map((panel) => <span className="panel-tab" key={panel.id}>{panel.title}</span>)}
      <span className="panel-tab">More <span>▾</span></span>
    </div>
    <div className="sidepanel-tabs" role="tablist" aria-label={`${side} panels`} onKeyDown={tabKeys}>
      {visible.map((index) => {
        const panel = panels[index]!;
        return <button key={panel.id} className={`panel-tab ${panel.id === current ? "on" : ""}`}
          role="tab" aria-selected={panel.id === current} aria-controls={`panel-${side}`}
          tabIndex={panel.id === current ? 0 : -1} onClick={() => choose(panel.id)}>{panel.title}</button>;
      })}
    </div>
    {overflow.length > 0 && <button ref={trigger} className="panel-tab panel-more"
      aria-haspopup="menu" aria-expanded={open} aria-controls={`panel-menu-${side}`}
      onClick={() => { menuFromEnd.current = false; setOpen(!open); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          menuFromEnd.current = event.key === "ArrowUp";
          setOpen(true);
        }
      }}>More <span aria-hidden="true">▾</span></button>}
    {open && overflow.length > 0 && <div ref={menu} className="panel-overflow-menu"
      id={`panel-menu-${side}`} role="menu" aria-label="More panels" onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {overflow.map((panel) => <button role="menuitem" tabIndex={-1} key={panel.id}
        onClick={() => choose(panel.id)}>{panel.title}</button>)}
    </div>}
  </div>;
}
