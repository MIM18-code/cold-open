// The open script's pagination, kept current while the writer types: re-run 300 ms after the document stops
// changing, after an Open, when the printing settings change, and whenever an editor appears. Feeds the
// editor's page breaks and the status bar. currentPagination and useCurrentPagination give other views the
// same pages for whichever version of the script they show.
import { pageLocks, type Pagination, type Script } from "@screenplay/engine";
import PaginationWorker from "./pagination.worker.ts?worker";
import { useMemo, useSyncExternalStore } from "react";

import { app as openApp, type App } from "../../core/app.ts";
import type { EditorBridge } from "../../core/editor-bridge.ts";
import { useApp } from "../../core/hooks.ts";
import { SETTINGS, readPrintSettings, sharedPagination } from "./options.ts";
import { pageBreaks } from "./pages.ts";

const DELAY = 300;

let current: Pagination | null = null;
const listeners = new Set<() => void>();

function publish(next: Pagination): void {
  current = next;
  for (const listener of listeners) listener();
}

export function usePagination(): Pagination | null {
  return useSyncExternalStore((onChange) => (listeners.add(onChange), () => listeners.delete(onChange)), () => current);
}

export function latestPagination(): Pagination | null {
  return current;
}

function settingsKey(app: App): string {
  return JSON.stringify(Object.values(SETTINGS).map((key) => app.settings[key] ?? null));
}

/**
 * The open document's pagination with the printing settings and its locked pages, shared by every view.
 * `script` defaults to the document as it is now; a view showing a debounced script passes that one.
 */
export function currentPagination(app: App, script: Script = app.session.script()): Pagination {
  const doc = app.session.doc;
  return sharedPagination(script, readPrintSettings(app.settings), () => pageLocks(doc));
}

/** currentPagination for a component: recomputed when the script or the printing settings change. */
export function useCurrentPagination(script: Script): Pagination {
  const key = useApp(settingsKey);
  return useMemo(() => currentPagination(openApp, script), [script, key]);
}

/** Start keeping the pagination current. Returns a function that stops it. */
export function startLivePagination(app: App): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let editor: EditorBridge | null = app.editor;
  let settings = settingsKey(app);
  let worker: Worker | undefined;
  let workerFailed = false;
  let requestId = 0;

  const apply = (pagination: Pagination) => {
    publish(pagination);
    app.editor?.setPageBreaks(pageBreaks(pagination));
  };
  const runSynchronous = () => {
    try { apply(currentPagination(app)); }
    catch (error) { console.error("Pagination failed", error); }
  };
  const runBackground = () => {
    // The in-memory browser test uses about:blank: it cannot resolve a bundled worker URL.
    // Degrade safely in environments where Worker isn't available.
    if (workerFailed || typeof Worker === "undefined" || location.protocol === "about:") return runSynchronous();
    try {
      if (!worker) {
        worker = new PaginationWorker();
        worker.onmessage = (event: MessageEvent<{ id: number; pagination?: Omit<Pagination, "positions"> & { positions: [string, { page: number; line: number }][] }; error?: string }>) => {
          if (event.data.id !== requestId) return; // Discard obsolete document/settings results.
          if (event.data.error || !event.data.pagination) {
            console.error("Background pagination failed", event.data.error);
            return runSynchronous();
          }
          const pagination = { ...event.data.pagination, positions: new Map(event.data.pagination.positions) };
          apply(pagination);
        };
        worker.onerror = (event) => {
          console.error("Pagination worker stopped", event.message);
          worker?.terminate(); worker = undefined; workerFailed = true;
          runSynchronous();
        };
      }
      const id = ++requestId;
      worker.postMessage({ id, script: app.session.script(), settings: readPrintSettings(app.settings), locks: pageLocks(app.session.doc) });
    } catch (error) {
      console.error("Could not start background pagination", error);
      worker?.terminate(); worker = undefined; workerFailed = true;
      runSynchronous();
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    ++requestId; // Invalidate any result made while another keystroke arrived.
    timer = setTimeout(runBackground, DELAY);
  };

  let offChange = app.session.onChange(schedule);
  const offSession = app.onSession((session) => {
    offChange();
    offChange = session.onChange(schedule);
    ++requestId;
    runSynchronous(); // New documents need correct page numbers immediately.
  });
  const offApp = app.subscribe(() => {
    if (app.editor !== editor) {
      editor = app.editor;
      if (editor && current) editor.setPageBreaks(pageBreaks(current));
    }
    const next = settingsKey(app);
    if (next !== settings) { settings = next; schedule(); }
  });
  runSynchronous();
  return () => {
    clearTimeout(timer);
    ++requestId;
    worker?.terminate();
    offChange(); offSession(); offApp();
  };
}
