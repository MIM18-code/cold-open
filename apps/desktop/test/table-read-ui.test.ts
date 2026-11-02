import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { ScreenplayDoc, type CastBinding, type Script } from "@screenplay/engine";
import * as engine from "@screenplay/engine";
import * as yjs from "yjs";
import * as diff from "lib0/diff";
import type { ReadPlayer } from "../src/renderer/features/table-read/player.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { ignoreAlias, readStoredCast, writeCast } from "../src/renderer/features/table-read/cast-store.ts";
import { buildSidecar, matchSidecar } from "../src/renderer/features/table-read/sidecar.ts";

type Component = (props: object) => Element | null;
interface Element {
  type: string | Component;
  props: {
    children?: unknown;
    binding?: CastBinding;
    "aria-label"?: string;
    disabled?: boolean;
    onChange?: (event: { target: { value: string } }) => void;
    onClick?: () => void | Promise<void>;
    onLock?: (locked: boolean) => void;
    onVoice?: (voice: string) => void;
  };
}
interface TestApi {
  reader: { panels: [{ component: Component }] };
  RestoreReview: Component;
  VoiceDesign: Component;
  VoicePacks: Component;
  AliasList: Component;
  getReader(): ReadPlayer;
}

let javascript: string;
// Run the actual panel handlers in Node without requiring Electron or browser launch permissions.
const mockModules: Record<string, string> = {
  react: `
    export const useState = (value) => globalThis.hooks.useState(value);
    export const useMemo = (fn) => fn();
    export const useEffect = (fn, deps) => globalThis.hooks.useEffect(fn, deps);
    export const useSyncExternalStore = (_, snapshot) => snapshot();
    export const useRef = (value) => globalThis.hooks.useState(() => ({ current: value }))[0];
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
    export const useSetting = (key, fallback) => [globalThis.fixture.settings[key] ?? fallback, () => {}];
  `,
  "app.ts": "export const app = globalThis.fixture.app;",
  "platform.ts": `
    export const desktop = globalThis.fixture.desktop;
    export const isDesktop = false;
    export const messageBox = async () => globalThis.fixture.messageBox();
  `,
};

before(async () => {
  const result = await build({
    stdin: {
      contents: `
        export { default as reader, getReader } from "./src/renderer/features/table-read/index.tsx";
        export { RestoreReview } from "./src/renderer/features/table-read/persistence.tsx";
        export { VoiceDesign } from "./src/renderer/features/table-read/voice-design.tsx";
        export { VoicePacks } from "./src/renderer/features/local-features/voice-packs.tsx";
        export { AliasList } from "./src/renderer/features/table-read/cast-panel.tsx";
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    packages: "external", loader: { ".css": "empty" },
    plugins: [{ name: "component-hooks", setup(plugin) {
      plugin.onResolve({ filter: /^react(?:\/jsx-runtime)?$|\/core\/(hooks|app|platform)\.ts$/ }, (args) => ({
        path: args.path.startsWith("react") ? args.path : args.path.split("/").at(-1)!, namespace: "mock",
      }));
      plugin.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mockModules[args.path]! }));
    } }],
  });
  javascript = result.outputFiles[0]!.text;
});

const paragraph = (id: string, type: "sceneHeading" | "character" | "dialogue", text: string) =>
  ({ id, type, runs: [{ text }] });
const SCRIPT: Script = { titlePage: [], paragraphs: [
  paragraph("s", "sceneHeading", "INT. DINER - NIGHT"),
  paragraph("m1", "character", "MAYA"), paragraph("md", "dialogue", "Stay here."),
  paragraph("e1", "character", "ELI"), paragraph("ed", "dialogue", "We should go."),
  paragraph("n1", "character", "NORA"), paragraph("nd", "dialogue", "Before dawn."),
] };

function fixture(script = SCRIPT) {
  const session = new DocumentSession(ScreenplayDoc.fromScript(script), {
    path: "/tmp/reader-ui.fdx", format: "fdx", name: "Reader",
  });
  const storage = new Map<string, string>();
  const fixture = {
    messageBox: async () => 0,
    session, settings: { "tableRead.options": {
      action: false, headings: false, names: false, parentheticals: false,
    } } as Record<string, unknown>,
    app: { session, flushPending() {}, toast() {}, setting: (_: string, fallback: unknown) => fallback },
    desktop: {
      async invoke(channel: string) {
        if (channel === "table-read:synthesize") return { audio: new Uint8Array(), cached: false };
        if (channel === "table-read:status") return { engines: ["system", "qwen"].map((id) => ({
          id, ready: true, available: true,
          voices: ["narrator", "maya", "eli", "nora"].map((voice) =>
            ({ id: `${id}-${voice}`, label: voice, language: "en-US" })),
        })) };
      },
      on: () => () => {},
    },
  };
  const slots: unknown[] = [], effects: (() => void)[] = [];
  let cursor = 0;
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value: unknown) => {
        slots[index] = typeof value === "function" ? value(slots[index]) : value;
      }];
    },
    useEffect(fn: () => void, deps: unknown[]) {
      const index = cursor++, previous = slots[index] as unknown[] | undefined;
      if (!previous || deps.some((value, i) => previous[i] !== value)) effects.push(fn);
      slots[index] = deps;
    },
  };
  class AudioContext {
    currentTime = 0;
    sampleRate = 24_000;
    destination = {};
    async decodeAudioData() { return { duration: 10 }; }
    async resume() {}
    async suspend() {}
    createBufferSource() {
      return { playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {}, stop() {} };
    }
  }
  const module = { exports: {} as TestApi };
  runInNewContext(javascript, {
    module, exports: module.exports, fixture, hooks, console, crypto, structuredClone,
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    URL, Blob, Event,
    setTimeout, clearTimeout, AbortController, AudioContext, Uint8Array, TextEncoder, TextDecoder,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value) },
    require: (name: string) => {
      if (name === "@screenplay/engine") return engine;
      if (name === "yjs") return yjs;
      if (name === "lib0/diff") return diff;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return {
    session, storage, settings: fixture.settings, api: module.exports, fixture,
    render(component: Component, props: object = {}) {
      cursor = 0;
      const element = component(props);
      for (const effect of effects.splice(0)) effect();
      return element;
    },
  };
}
function elements(root: unknown): Element[] {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!root || typeof root !== "object" || !("props" in root)) return [];
  const element = root as Element;
  return [element, ...elements(element.props.children)];
}
function find(root: unknown, predicate: (element: Element) => boolean): Element {
  const element = elements(root).find(predicate);
  assert(element, "expected component control");
  return element;
}

for (const bundle of [false, true]) {
  test(`review applies chosen destinations, unmatched rows and Don't attach (${bundle ? "bundle" : "sidecar"})`, async () => {
    const source = new DocumentSession(ScreenplayDoc.fromScript(SCRIPT), { format: "fdx" });
    writeCast(source, { characters: [
      { id: "m1", name: "MAYA", aliases: [], locked: true, voices: { system: "maya" } },
      { id: "e1", name: "ELI", aliases: [], locked: false, voices: { system: "eli" } },
      { id: "n1", name: "NORA", aliases: [], locked: false, voices: { system: "nora" } },
    ] });
    const sidecar = buildSidecar(source, { projectId: crypto.randomUUID() });
    const changed = structuredClone(SCRIPT);
    changed.paragraphs.splice(-2, 2, paragraph("new", "character", "VOSS"),
      paragraph("newd", "dialogue", "A different line."));
    const f = fixture(changed);
    const match = matchSidecar(sidecar, f.session.script(), "fdx");
    const props = { props: { sessionId: f.session.id, sidecar, match, source: bundle ? "bundle" : "sidecar",
      ...(bundle ? { bundle: { project: sidecar, references: [] } } : {}) }, close() {} };
    const render = () => f.render(f.api.RestoreReview, props);
    for (const [name, destination] of [["MAYA", "e1"], ["ELI", ""], ["NORA", "new"]] as const) {
      const control = find(render(), (e) => e.props["aria-label"] === `Character for ${name}`);
      control.props.onChange!({ target: { value: destination } });
    }
    await find(render(), (e) => e.type === "button" && e.props.children === "Attach selected").props.onClick!();
    // The click starts an async import for bundles, just as the renderer does.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(readStoredCast(f.session.doc).characters.map((c) => [c.id, c.voices.system]),
      [["e1", "maya"], ["new", "nora"]]);
  });
}

test("locking an automatic voice persists the resolved voices for every shown engine", async () => {
  const f = fixture();
  const component = f.api.reader.panels[0].component;
  f.render(component);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const maya = find(f.render(component), (e) => e.props.binding?.id === "m1");
  assert.equal(maya.props.binding!.voices.system, "system-maya");
  maya.props.onLock!(true);
  assert.equal(readStoredCast(f.session.doc).characters[0]!.voices.system, "system-maya");
  const eli = find(f.render(component), (e) => e.props.binding?.id === "e1");
  eli.props.onVoice!("system-maya");
  assert.equal(find(f.render(component), (e) => e.props.binding?.id === "m1")
    .props.binding!.voices.system, "system-maya");
  f.settings["tableRead.engine"] = "qwen";
  find(f.render(component), (e) => e.props.binding?.id === "m1").props.onLock!(true);
  const stored = readStoredCast(f.session.doc).characters.find((c) => c.id === "m1")!;
  assert.deepEqual(stored.voices, { qwen: "qwen-maya", system: "system-maya" });
  assert.equal(stored.locked, true);
});

test("Different dismisses a suggested alias using the stored pair", () => {
  const f = fixture();
  const suggestion = { characterId: "m1", aliasCharacterId: "e1", name: "OLD MAYA", reason: "Related name." };
  const props = { suggestions: [suggestion], names: { m1: "MAYA" }, ignored: [] as string[], disabled: false,
    onMerge() {}, onDifferent() { ignoreAlias(f.session, suggestion.characterId, suggestion.name); } };
  const tree = f.render(f.api.AliasList, props);
  find(tree, (e) => e.type === "button" && e.props.children === "Different").props.onClick!();
  props.ignored = readStoredCast(f.session.doc).ignoredAliases;
  assert.equal(f.render(f.api.AliasList, props), null);
});

test("Resume reads the latest passage after playback advances in the same session", async (t) => {
  const f = fixture();
  const player = f.api.getReader();
  t.after(() => player.close());
  const key = `tableRead.resume:${f.session.path}`;
  f.storage.set(key, JSON.stringify({ paragraphId: "md", offset: 0 }));
  const component = f.api.reader.panels[0].component;
  const render = () => f.render(component);
  const resume = () => find(render(), (e) => e.props.children === "Resume saved passage").props.onClick!();
  render();
  await new Promise((resolve) => setTimeout(resolve, 0));
  resume();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(player.state, "playing");
  assert.equal(player.index, 0);
  player.seek(2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.parse(f.storage.get(key)!).paragraphId, "nd");
  player.stop();
  resume();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(player.index, 2);
  assert.equal(player.cues[player.index]!.source[0]!.paragraphId, "nd");
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const button = (root: unknown, text: string) => find(root, (e) => e.type === "button" && e.props.children === text);
const setupPack = { id: "phonon", engine: "phonon", label: "Fixture pack", installed: false, sizeBytes: 1024 ** 2,
  diskBytes: 0, memoryGB: 16, minimumMacOS: 15, license: "test-license", licenseUrls: [], provenance: "Synthetic fixture", revision: [] };

test("pack UI gates download on size/license confirmation and low-memory consent, then cancels and retries", async () => {
  const f = fixture(), calls: unknown[][] = [];
  let fail: ((reason: Error) => void) | undefined;
  let progress: ((value: unknown) => void) | undefined;
  Object.defineProperty(f.fixture.desktop, "on", { value: (_channel: string, listener: (value: unknown) => void) => { progress = listener; return () => {}; } });
  Object.defineProperty(f.fixture.desktop, "invoke", { value: async (channel: string, ...args: unknown[]) => {
    calls.push([channel, ...args]);
    if (channel === "table-read:models") return [setupPack];
    if (channel === "table-read:status") return { memoryGB: 8, engines: [] };
    if (channel === "table-read:install") return new Promise((_resolve, reject) => { fail = reject; });
    if (channel === "table-read:cancel") fail?.(new Error("Cancelled"));
  } });
  let root = f.render(f.api.VoicePacks); await settle(); root = f.render(f.api.VoicePacks);
  button(root, "Install…").props.onClick!(); root = f.render(f.api.VoicePacks);
  assert(elements(root).some((e) => typeof e.props.children === "object" && JSON.stringify(e.props.children).includes("test-license")));
  assert.equal(button(root, "Confirm download").props.disabled, true);
  assert.equal(calls.filter((c) => c[0] === "table-read:install").length, 0);
  const checkbox = find(root, (e) => e.type === "input");
  (checkbox.props.onChange as unknown as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  root = f.render(f.api.VoicePacks); assert.equal(button(root, "Confirm download").props.disabled, false);
  button(root, "Confirm download").props.onClick!(); await settle(); root = f.render(f.api.VoicePacks);
  assert.deepEqual(calls.find((c) => c[0] === "table-read:install"), ["table-read:install", "phonon", true, true]);
  progress!({ packId: "phonon", completedBytes: 524288, totalBytes: 1048576 }); root = f.render(f.api.VoicePacks);
  assert(elements(root).some((e) => e.type === "progress"));
  button(root, "Cancel download").props.onClick!(); await settle(); root = f.render(f.api.VoicePacks);
  assert(button(root, "Retry…"));
  button(root, "Retry…").props.onClick!(); root = f.render(f.api.VoicePacks);
  assert.equal(button(root, "Confirm download").props.disabled, true, "retry needs fresh low-memory acknowledgement");
});

test("design UI keeps only an audition, binds the reference to the latest character and locks Qwen", async () => {
  const f = fixture(), requests: { action: string; provenance?: string }[] = [];
  let closed = false, selected = "";
  Object.assign(f.fixture.app, { async setSetting(_key: string, value: string) { selected = value; } });
  Object.defineProperty(f.fixture.desktop, "invoke", { value: async (channel: string, input: { action: string; provenance?: string }) => {
    if (channel === "table-read:status") return { memoryGB: 32, models: [{ ...setupPack, id: "qwen-design", installed: true }] };
    if (channel === "table-read:design-voice") {
      requests.push(input);
      if (input.action === "preview") return { id: "designed", audio: new Uint8Array(48) };
      if (input.action === "keep") return { id: "designed", label: "MAYA", engine: "qwen" };
    }
  } });
  const props = { props: { session: f.session.id, character: "m1", name: "MAYA" }, close: () => { closed = true; } };
  let root = f.render(f.api.VoiceDesign, props);
  find(root, (e) => e.type === "textarea").props.onChange!({ target: { value: "Gravelly adult alto" } });
  root = f.render(f.api.VoiceDesign, props);
  button(root, "Generate audition").props.onClick!(); await settle(); root = f.render(f.api.VoiceDesign, props);
  assert.equal(requests[0]?.action, "preview"); assert.match(requests[0]!.provenance!, /Private; do not share/);
  assert.equal(readStoredCast(f.session.doc).characters.length, 0, "preview must not write cast data");
  assert.equal(button(root, "Keep voice").props.disabled, false);
  button(root, "Keep voice").props.onClick!(); await settle();
  assert.equal(closed, true); assert.equal(selected, "qwen");
  const saved = readStoredCast(f.session.doc).characters.find((c) => c.id === "m1")!;
  assert.equal(saved.voices.qwen, "designed"); assert.equal(saved.locked, true);
});

test("voice design refuses to save a preview into a newly read-only document", async () => {
  const f = fixture(); let kept = false;
  Object.defineProperty(f.fixture.desktop, "invoke", { value: async (channel: string, input: { action: string }) => {
    if (channel === "table-read:status") return { memoryGB: 32, models: [{ ...setupPack, id: "qwen-design", installed: true }] };
    if (channel === "table-read:design-voice" && input.action === "preview") return { id: "designed", audio: new Uint8Array(48) };
    if (channel === "table-read:design-voice" && input.action === "keep") kept = true;
  } });
  const props = { props: { session: f.session.id, character: "m1", name: "MAYA" }, close() {} };
  let root = f.render(f.api.VoiceDesign, props);
  find(root, (e) => e.type === "textarea").props.onChange!({ target: { value: "Soft adult tenor" } });
  root = f.render(f.api.VoiceDesign, props); button(root, "Generate audition").props.onClick!(); await settle();
  root = f.render(f.api.VoiceDesign, props); f.session.setReadOnly(true);
  button(root, "Keep voice").props.onClick!(); await settle(); root = f.render(f.api.VoiceDesign, props);
  assert.equal(kept, false);
  assert(elements(root).some((e) => typeof e.props.children === "string" && e.props.children.includes("read-only")));
});

for (const beforeGeneration of [false, true]) test(`voice design confirms a cast change ${beforeGeneration ? "before first generation" : "across regeneration"}`, async () => {
  const f = fixture();
  let confirmations = 0, keeps = 0;
  f.fixture.messageBox = async () => { confirmations++; return 1; };
  Object.defineProperty(f.fixture.desktop, "invoke", { value: async (channel: string, input: { action: string }) => {
    if (channel === "table-read:status") return { memoryGB: 32, models: [{ ...setupPack, id: "qwen-design", installed: true }] };
    if (channel === "table-read:design-voice" && input.action === "preview") return { id: "designed", audio: new Uint8Array(48) };
    if (channel === "table-read:design-voice" && input.action === "keep") keeps++;
  } });
  const props = { props: { session: f.session.id, character: "m1", name: "MAYA" }, close() {} };
  const render = () => f.render(f.api.VoiceDesign, props);
  find(render(), (e) => e.type === "textarea").props.onChange!({ target: { value: "Soft adult tenor" } });
  if (!beforeGeneration) { button(render(), "Generate audition").props.onClick!(); await settle(); }
  writeCast(f.session, { characters: [{ id: "m1", name: "MAYA", aliases: [], locked: true, voices: { qwen: "other-writer" } }] });
  button(render(), beforeGeneration ? "Generate audition" : "Regenerate").props.onClick!(); await settle();
  button(render(), "Keep voice").props.onClick!(); await settle();
  assert.equal(confirmations, 1);
  assert.equal(keeps, 0);
  const binding = readStoredCast(f.session.doc).characters.find((c) => c.id === "m1")!;
  assert.equal(binding.voices.qwen, "other-writer"); assert.equal(binding.locked, true);
});


test("voice design preserves the previous cast and audition when binding fails, then retries", async () => {
  const f = fixture();
  writeCast(f.session, { characters: [{ id: "m1", name: "MAYA", aliases: [], locked: false, voices: { qwen: "previous" } }] });
  const previous = readStoredCast(f.session.doc);
  let closed = false, fail = true, keeps = 0, binds = 0, discards = 0;
  Object.assign(f.fixture.app, { async setSetting() {} });
  Object.defineProperty(f.fixture.desktop, "invoke", { value: async (channel: string, input: { action: string }) => {
    if (channel === "table-read:status") return { memoryGB: 32, models: [{ ...setupPack, id: "qwen-design", installed: true }] };
    if (channel === "table-read:design-voice") {
      if (input.action === "preview") return { id: "designed", audio: new Uint8Array(48) };
      if (input.action === "keep") { keeps++; return { id: "designed", label: "MAYA", engine: "qwen" }; }
      if (input.action === "discard") discards++;
      if (input.action === "bind") {
        binds++;
        if (fail) throw new Error("ENOSPC: no space left on device");
        assert.deepEqual(readStoredCast(f.session.doc), previous, "cast must stay untouched until audio is published");
      }
    }
  } });
  const props = { props: { session: f.session.id, character: "m1", name: "MAYA" }, close: () => { closed = true; } };
  const render = () => f.render(f.api.VoiceDesign, props);
  find(render(), (e) => e.type === "textarea").props.onChange!({ target: { value: "Soft adult tenor" } });
  button(render(), "Generate audition").props.onClick!(); await settle();
  button(render(), "Keep voice").props.onClick!(); await settle();
  assert.deepEqual(readStoredCast(f.session.doc), previous);
  assert.equal(closed, false);
  assert(elements(render()).some((e) => typeof e.props.children === "string" && e.props.children.includes("ENOSPC")));
  assert.equal(button(render(), "Keep voice").props.disabled, false);
  assert.equal(discards, 0);
  fail = false;
  button(render(), "Keep voice").props.onClick!(); await settle();
  assert.equal(closed, true);
  assert.equal(keeps, 1); assert.equal(binds, 2);
  const binding = readStoredCast(f.session.doc).characters.find((c) => c.id === "m1")!;
  assert.equal(binding.voices.qwen, "designed"); assert.equal(binding.locked, true);
});
