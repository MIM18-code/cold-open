// Dialogs and side panels run in Node: each component is bundled with stand-ins for React, the app and the main
// process, rendered as a plain element tree, and its handlers called directly.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build, type Plugin } from "esbuild";
import { ScreenplayDoc, type Script } from "@screenplay/engine";
import * as engine from "@screenplay/engine";
import * as yjs from "yjs";
import { CHANNELS } from "../src/shared/api.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";

type Component = (props: object) => unknown;
interface Element { type: string | Component; props: Record<string, any> }
interface Modal { id: string; component: Component }
interface Feature { modals?: Modal[]; commands?: { id: string; enabled?: (app: unknown) => boolean }[] }
interface TestApi {
  notes: Feature; reports: Feature; rename: Feature; revisions: Feature;
  AssistantPanel: Component; useSessionState: () => unknown;
}

const mockModules: Record<string, string> = {
  react: `
    export const useState = (value) => globalThis.hooks.useState(value);
    export const useMemo = (fn) => fn();
    export const useEffect = () => {};
    export const useCallback = (fn, deps) => globalThis.hooks.useCallback(fn, deps);
    export const useSyncExternalStore = (subscribe, snapshot) => globalThis.hooks.store(subscribe, snapshot);
    export const useRef = (value) => globalThis.hooks.useState(() => ({ current: value }))[0];
    export const Fragment = "fragment";
    export const startTransition = (fn) => fn();
  `,
  "react/jsx-runtime": `
    export const jsx = (type, props) => ({ type, props });
    export const jsxs = jsx;
    export const Fragment = "fragment";
  `,
  "hooks.ts": `
    export const useSession = () => globalThis.fixture.session;
    export const useScript = () => globalThis.fixture.session.script();
    export const useSessionState = () => globalThis.fixture.session;
    export const useDocVersion = () => globalThis.fixture.session.version;
    export const useSetting = (key, fallback) => [fallback, () => {}];
    export const useApp = (select) => select(globalThis.fixture.app);
    export const useEditor = () => globalThis.fixture.app.editor;
  `,
  "app.ts": "export const app = globalThis.fixture.app;",
  "platform.ts": `
    export const desktop = globalThis.fixture.desktop;
    export const isDesktop = true;
    export const messageBox = async () => 0;
  `,
  "live.ts": "export const useCurrentPagination = () => undefined; export const usePagination = () => null;",
};

/** Stand in for React and the app's own modules; `keep` names modules that load for real. */
function mocks(keep: string[] = []): Plugin {
  return { name: "component-mocks", setup(plugin) {
    plugin.onResolve({ filter: /^react(?:\/jsx-runtime)?$|\/core\/(hooks|app|platform)\.ts$|\/print\/live\.ts$/ }, (args) => {
      const name = args.path.startsWith("react") ? args.path : args.path.split("/").at(-1)!;
      return keep.includes(name) ? undefined : { path: name, namespace: "mock" };
    });
    plugin.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mockModules[args.path]! }));
  } };
}

async function bundle(contents: string, plugin: Plugin): Promise<string> {
  const result = await build({
    stdin: { contents, resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    packages: "external", loader: { ".css": "empty" }, plugins: [plugin],
  });
  return result.outputFiles[0]!.text;
}

let components: string, realHooks: string;
before(async () => {
  components = await bundle(`
    export { default as notes } from "./src/renderer/features/script-notes/index.tsx";
    export { default as reports } from "./src/renderer/features/reports/index.tsx";
    export { default as rename } from "./src/renderer/features/rename/index.tsx";
    export { default as revisions } from "./src/renderer/features/revisions/index.tsx";
    export { AssistantPanel } from "./src/renderer/features/assistant/Panel.tsx";
  `, mocks());
  realHooks = await bundle(`export { useSessionState } from "./src/renderer/core/hooks.ts";`, mocks(["hooks.ts"]));
});

const SCRIPT: Script = { titlePage: [], paragraphs: [
  { id: "s", type: "sceneHeading", runs: [{ text: "INT. DINER - NIGHT" }] },
  { id: "a", type: "action", runs: [{ text: "Bob waits." }] },
  { id: "c", type: "character", runs: [{ text: "BOB " }, { text: "maybe ROBERT?", note: true }] },
  { id: "d", type: "dialogue", runs: [{ text: "Coffee." }] },
] };

function load(javascript = components, script = SCRIPT) {
  const session = new DocumentSession(ScreenplayDoc.fromScript(script), { path: "/tmp/dialogs.fdx", format: "fdx", name: "Dialogs" });
  const invoked: { channel: string; args: unknown[] }[] = [];
  const selectionListeners = new Set<() => void>();
  const subscriptions: unknown[] = [];
  const fixture = {
    session,
    invoke: async (channel: string, ..._args: unknown[]): Promise<unknown> => undefined,
    desktop: { invoke: (channel: string, ...args: unknown[]) => (invoked.push({ channel, args }), fixture.invoke(channel, ...args)), on: () => () => {} },
    toasts: [] as string[],
    app: {
      session, editor: {
        currentParagraphId: () => "c", getSelection: () => null,
        onSelectionChange(listener: () => void) { selectionListeners.add(listener); return () => selectionListeners.delete(listener); },
      },
      flushPending() {}, refreshMenu() {}, toast(message: string) { fixture.toasts.push(message); },
      setting: (_key: string, fallback: unknown) => fallback, onSession: () => () => {}, subscribe: () => () => {},
    },
  };
  const slots: unknown[] = [];
  let cursor = 0;
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? (value as (v: unknown) => unknown)(slots[index]) : value; }];
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const index = cursor++, previous = slots[index] as { fn: unknown; deps: unknown[] } | undefined;
      if (!previous || deps.some((value, i) => previous.deps[i] !== value)) slots[index] = { fn, deps };
      return (slots[index] as { fn: unknown }).fn;
    },
    store(subscribe: (onChange: () => void) => () => void, snapshot: () => unknown) {
      subscriptions.push(subscribe);
      subscribe(() => {});
      return snapshot();
    },
  };
  const module = { exports: {} as TestApi };
  runInNewContext(javascript, {
    module, exports: module.exports, fixture, hooks, console, setTimeout, clearTimeout, queueMicrotask,
    requestAnimationFrame: () => 0, window: {},
    require: (name: string) => name === "@screenplay/engine" ? engine : name === "yjs" ? yjs : (() => { throw new Error(`Unexpected ${name}`); })(),
  });
  const render = (component: Component, props: object = {}) => { cursor = 0; return component(props) as Element; };
  return { api: module.exports, fixture, session, render, invoked, selectionListeners, subscriptions };
}

function all(node: unknown, match: (element: Element) => boolean, out: Element[] = []): Element[] {
  if (Array.isArray(node)) for (const child of node) all(child, match, out);
  else if (node && typeof node === "object" && "props" in node) {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props.children, match, out);
  }
  return out;
}
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children) : "";
}
const button = (tree: unknown, label: string) => all(tree, (e) => e.type === "button" && text(e.props.children) === label)[0]!;
const modal = (feature: Feature, id: string) => feature.modals!.find((m) => m.id === id)!.component;

test("the script note editor keeps what the writer typed when its passage is deleted", () => {
  const { api, session, render } = load();
  const EditNote = modal(api.notes, "fdxNotes.edit");
  const closed: boolean[] = [];
  const props = { props: { sessionId: session.id, version: session.version, attach: { from: { paragraphId: "a", offset: 0 }, to: { paragraphId: "a", offset: 3 } } }, close: () => closed.push(true) };
  let tree = render(EditNote, props);
  all(tree, (e) => e.props["aria-label"] === "Script note text")[0]!.props.onChange({ target: { value: "Cut this line?" } });
  // A co-writer deletes the paragraph the note was going to be pinned to.
  session.edit(() => session.doc.load({ ...SCRIPT, paragraphs: SCRIPT.paragraphs.filter((p) => p.id !== "a") }));
  tree = render(EditNote, props);
  assert.equal(all(tree, (e) => e.props["aria-label"] === "Script note text")[0]!.props.value, "Cut this line?");
  button(tree, "Save note").props.onClick();
  tree = render(EditNote, props);
  assert.deepEqual(closed, []);
  assert.equal(all(tree, (e) => e.props.role === "alert").length, 1);
  assert.equal(all(tree, (e) => e.props["aria-label"] === "Script note text")[0]!.props.value, "Cut this line?");
});

test("Export Sides shows a failed save and cannot start twice", async () => {
  const { api, fixture, render, invoked } = load();
  fixture.invoke = async (channel) => {
    if (channel === CHANNELS.saveDialog) return "/Volumes/Gone/Dialogs sides.fdx";
    if (channel === CHANNELS.writeFile) throw new Error("The disk is full.");
  };
  const Sides = modal(api.reports, "reports.sides");
  const closed: boolean[] = [];
  const props = { close: () => closed.push(true) };
  button(render(Sides, props), "Select all").props.onClick();
  const exportButton = button(render(Sides, props), "Export…");
  exportButton.props.onClick();
  exportButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(invoked.filter((call) => call.channel === CHANNELS.saveDialog).length, 1);
  assert.deepEqual(closed, []);
  assert.match(text(all(render(Sides, props), (e) => e.props.role === "alert")), /disk is full/);
});

test("Rename Character preselects the cue's name without its inline note", () => {
  const { api, render } = load();
  const tree = render(modal(api.rename, "rename.main"), { close() {}, props: undefined });
  assert.equal(text(all(tree, (e) => e.props.className === "rename-preview")), "Type a new name for BOB.");
});

test("Show Revision Marks is off for a read-only guest, as the other revision commands are", () => {
  const { api, session, fixture } = load();
  const showMarks = api.revisions.commands!.find((c) => c.id === "revisions.showMarks")!;
  assert.equal(showMarks.enabled?.(fixture.app) ?? true, true);
  session.setReadOnly(true);
  assert.equal(showMarks.enabled?.(fixture.app) ?? true, false);
});

test("the assistant follows the editor's selection, not only app updates", () => {
  const { api, render, selectionListeners } = load();
  render(api.AssistantPanel);
  assert.ok(selectionListeners.size > 0);
});

test("useSessionState keeps one subscription across renders", () => {
  const { api, render, subscriptions } = load(realHooks);
  // The last five stores are the session's path, name, format, dirty and read-only flags.
  render(api.useSessionState);
  const first = subscriptions.slice(-5);
  render(api.useSessionState);
  assert.deepEqual(subscriptions.slice(-5), first);
});

test("closing a dialog leaves focus to the dialog, which returns it to the control that opened it", async () => {
  Object.assign(globalThis, { window: { desktop: { invoke: async () => undefined, on: () => () => {}, platform: "darwin" } } });
  const { app } = await import("../src/renderer/core/app.ts");
  let focused = 0;
  const editor = app.editor;
  Object.assign(app, { editor: { focus: () => focused++ } });
  try {
    app.openModal("settings");
    app.closeModal();
    assert.equal(app.ui.modal, null);
    // The workspace is still inert when closeModal runs; Shell's dialog focus puts focus back after it renders.
    assert.equal(focused, 0);
  } finally {
    Object.assign(app, { editor });
  }
});
