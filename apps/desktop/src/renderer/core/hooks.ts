// React hooks over the app object. Components re-render when the slice they read changes.
import type { Script } from "@screenplay/engine";
import { startTransition, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { app, type App } from "./app.ts";
import type { EditorBridge } from "./editor-bridge.ts";
import type { DocumentSession, SourceFormat } from "./session.ts";

/**
 * Re-render on app state changes and return a derived value. The selector runs once per app state revision,
 * so it may build new arrays; the component re-renders only when the result changes (shallowly, for arrays).
 */
export function useApp<T>(select: (app: App) => T): T {
  const last = useRef<{ revision: number; select: (app: App) => T; value: T } | null>(null);
  return useSyncExternalStore(
    (onChange) => app.subscribe(onChange),
    () => {
      const cached = last.current;
      if (cached && cached.revision === app.revision && cached.select === select) return cached.value;
      const value = select(app);
      // Equal results keep the previous reference, so a selector that builds a new array does not loop.
      const stable = cached && sameValue(cached.value, value) ? cached.value : value;
      last.current = { revision: app.revision, select, value: stable };
      return stable;
    },
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
}

export function useSession(): DocumentSession {
  return useApp((a) => a.session);
}

export function useEditor(): EditorBridge | null {
  return useApp((a) => a.editor);
}

/** The document version, bumped on every change. Use it as an effect dependency. */
export function useDocVersion(): number {
  const session = useSession();
  return useSyncExternalStore((onChange) => session.onChange(onChange), () => session.version);
}

/**
 * The plain script, refreshed after the document has been still for `delay` ms. Panels that summarize the
 * whole script (navigator, reports) use this so typing stays fast on long scripts.
 */
export function useScript(delay = 250): Script {
  const session = useSession();
  const [state, setState] = useState(() => ({ session, script: session.script() }));
  // A swapped document must never be paired with the previous document's script, even for one render.
  let script = state.script;
  if (state.session !== session) {
    script = session.script();
    setState({ session, script });
  }
  const setScript = (next: Script) => setState({ session, script: next });
  useEffect(() => {
    setScript(session.script());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = session.onChange(() => {
      clearTimeout(timer);
      // A transition, so React can render a long panel in slices and a key pressed meanwhile is not kept waiting.
      timer = setTimeout(() => {
        const next = session.script();
        startTransition(() => setScript(next));
      }, delay);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [session, delay]);
  return script;
}

/** Session path, name, format, dirty flag and read-only flag. */
export function useSessionState(): { path: string | null; name: string; format: SourceFormat; dirty: boolean; readOnly: boolean } {
  const session = useSession();
  const subscribe = (onChange: () => void) => session.onState(onChange);
  const path = useSyncExternalStore(subscribe, () => session.path);
  const name = useSyncExternalStore(subscribe, () => session.name);
  const format = useSyncExternalStore(subscribe, () => session.format);
  const dirty = useSyncExternalStore(subscribe, () => session.dirty);
  const readOnly = useSyncExternalStore(subscribe, () => session.readOnly);
  return { path, name, format, dirty, readOnly };
}

export function useSetting<T>(key: string, fallback: T): [T, (value: T) => void] {
  const value = useApp((a) => a.setting(key, fallback));
  return [value, (next: T) => void app.setSetting(key, next)];
}
