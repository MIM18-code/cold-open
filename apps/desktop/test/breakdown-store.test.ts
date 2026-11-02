import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import * as engine from "@screenplay/engine";
import { DocumentSession } from "../src/renderer/core/session.ts";
import type { BreakdownStore } from "../src/renderer/features/breakdown/store.ts";
import type { ProviderId } from "../src/shared/channels/ai.ts";

let javascript: string;
before(async () => {
  const mocks: Record<string, string> = {
    "app.ts": "export const app = globalThis.fixture.app;",
    "platform.ts": "export const desktop = globalThis.fixture.desktop; export const messageBox = globalThis.fixture.messageBox;",
    "client.ts": `export const runAi = globalThis.fixture.runAi;
      export class AiClientError extends Error { constructor(code, message) { super(message); this.code = code; } }`,
    "setup.ts": `export const cancelAiRetry = (owner) => globalThis.fixture.retries.delete(owner);
      export const retryWhenAiReady = (owner, retry) => globalThis.fixture.retries.set(owner, retry);`,
  };
  const result = await build({ entryPoints: [fileURLToPath(new URL("../src/renderer/features/breakdown/store.ts", import.meta.url))],
    bundle: true, write: false, format: "cjs", platform: "node", packages: "external",
    plugins: [{ name: "breakdown-services", setup(plugin) {
      plugin.onResolve({ filter: /\/core\/(app|platform)\.ts$|\/assistant\/(client|setup)\.ts$/ }, args => ({ path: args.path.split("/").at(-1)!, namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path]! }));
    } }],
  });
  javascript = result.outputFiles[0]!.text;
});

function fixture(provider: ProviderId = "ollama") {
  const session = new DocumentSession(engine.ScreenplayDoc.fromScript(engine.parseFountain("INT. ROOM - DAY\n\nMaya holds a revolver.\n\nMAYA\nGo.\n\nEXT. ROAD - NIGHT\n\nA car waits.")));
  const listeners = new Set<() => void>(), sessionListeners = new Set<(s: DocumentSession) => void>(), selectionListeners = new Set<() => void>();
  const settings: Record<string, unknown> = {}, requests: any[] = [], decorations: any[] = [], progress: string[] = [];
  let caret = session.script().paragraphs[0]!.id, chosen = provider, consents = 0, allow = true, cancellations = 0;
  const answers: (string | Promise<string>)[] = [];
  const retries = new Map<object, () => void>();
  const app = {
    session, settings, ui: { rightPanel: "breakdown" as string | null },
    editor: {
      currentParagraphId: () => caret,
      onSelectionChange: (listener: () => void) => { selectionListeners.add(listener); return () => selectionListeners.delete(listener); },
      setSelection: (position: { paragraphId: string }) => { caret = position.paragraphId; selectionListeners.forEach(fn => fn()); },
      revealParagraph: () => undefined,
      setDecorations: (_source: string, marks: any[]) => { decorations.push(marks); },
    },
    setting: <T,>(key: string, fallback: T) => (app.settings[key] as T | undefined) ?? fallback,
    setSetting: async (key: string, value: unknown) => { app.settings = { ...app.settings, [key]: value }; listeners.forEach(fn => fn()); },
    flushPending: () => undefined,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    onSession: (listener: (s: DocumentSession) => void) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
  };
  const services = {
    app,
    retries,
    desktop: { invoke: async () => ({ active: { provider: chosen }, providers: [{ provider: chosen, ready: true }] }) },
    messageBox: async () => { consents++; return allow ? 0 : 1; },
    runAi: (request: unknown) => {
      requests.push(request);
      const answer = answers.shift() ?? '{"elements":[]}';
      let reject!: (e: Error) => void;
      const done = new Promise<string>((resolve, refuse) => { reject = refuse; Promise.resolve(answer).then(resolve, refuse); });
      return { done, cancel: () => { cancellations++; reject(new Error("Cancelled")); } };
    },
  };
  const module = { exports: {} as { BreakdownStore: new () => BreakdownStore } };
  runInNewContext(javascript, { module, exports: module.exports, fixture: services, setTimeout, clearTimeout,
    require: (name: string) => { assert.equal(name, "@screenplay/engine"); return engine; } });
  const store = new module.exports.BreakdownStore(), stop = store.start();
  store.subscribe(() => progress.push(store.progress));
  return { app, session, store, answers, requests, decorations, progress,
    ready: () => { const pending = [...retries.values()]; retries.clear(); pending.forEach(retry => retry()); },
    consents: () => consents, cancellations: () => cancellations,
    allow: (value: boolean) => { allow = value; },
    provider: (value: ProviderId) => { chosen = value; },
    close: () => { stop(); app.session.destroy(); if (app.session !== session) session.destroy(); },
    swap: (next: DocumentSession) => { app.session = next; sessionListeners.forEach(fn => fn(next)); listeners.forEach(fn => fn()); },
    panel: (value: string | null) => { app.ui.rightPanel = value; listeners.forEach(fn => fn()); },
  };
}

test("setup retries the failed Breakdown request once and moving to another scene cancels the retry", async () => {
  const f = fixture();
  try {
    const missing = () => Object.assign(new Error("Set up AI to use this feature."), { setupRequired: true });
    f.answers.push(Promise.reject(missing()));
    await f.store.suggest(false);
    assert.equal(f.store.setupRequired, true);
    assert.equal(f.store.busy, false);
    f.ready();
    for (let i = 0; i < 30 && f.store.busy; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.requests.length, 2);
    assert.equal(f.store.setupRequired, false);
    assert.equal(f.store.error, "");
    f.ready();
    assert.equal(f.requests.length, 2);
    f.answers.push(Promise.reject(missing()));
    await f.store.suggest(false);
    f.store.next();
    f.ready();
    assert.equal(f.requests.length, 3);
  } finally { f.close(); }
});

test("cast appears without AI, malformed JSON retries once, a second parse failure is shown", async () => {
  const f = fixture();
  try {
    assert.equal(f.store.rows[0]!.label, "MAYA");
    assert.equal(f.requests.length, 0);
    f.answers.push("bad json", '{"elements":[{"category":"Props","label":"Gun","text":"revolver"}]}');
    await f.store.suggest(false);
    assert.equal(f.requests.length, 2);
    assert.equal(f.store.rows.length, 2);
    assert.equal(f.requests[0].provider, "ollama");
    assert.equal(f.requests[0].tier, "fast");
    assert.equal(f.requests[0].json, true);
    assert.equal(f.requests[0].maxTokens, 2000);
    f.answers.push("bad", "still bad");
    await f.store.suggest(false);
    assert.equal(f.requests.length, 4);
    assert.match(f.store.error, /elements array as JSON/);
    assert.equal(f.store.busy, false);
    assert.equal(engine.tagDefinitions(f.session.script()).length, 0);
  } finally { f.close(); }
});

test("whole-script local work is gated, and cloud work runs scenes in order for review", async () => {
  const local = fixture();
  try {
    await local.store.suggest(true);
    assert.equal(local.store.error, "Needs ChatGPT or an API key");
    assert.equal(local.requests.length, 0);
  } finally { local.close(); }
  const f = fixture("chatgpt");
  try {
    f.answers.push('{"elements":[{"category":"Props","label":"Revolver","text":"revolver"}]}', '{"elements":[{"category":"Vehicles","label":"Car","text":"car"}]}');
    await f.store.suggest(true);
    assert.equal(f.consents(), 1);
    assert.equal(f.requests.length, 2);
    assert.match(f.requests[0].messages[0].content, /INT\. ROOM/);
    assert.match(f.requests[1].messages[0].content, /EXT\. ROAD/);
    assert.ok(f.progress.includes("Scene 1 of 2") && f.progress.includes("Scene 2 of 2"));
    assert.equal(f.store.rows.length, 3);
    assert.equal(engine.tagDefinitions(f.session.script()).length, 0);
    f.store.tag();
    assert.equal(engine.tagDefinitions(f.session.script()).length, 3);
    f.session.undo.undo();
    assert.equal(engine.tagDefinitions(f.session.script()).length, 0);
    await f.store.suggest(false);
    assert.equal(f.consents(), 1, "consent is remembered for the provider");
    f.provider("google");
    await f.store.suggest(false);
    assert.equal(f.consents(), 2, "each cloud provider needs its own consent");
  } finally { f.close(); }
});

test("declining cloud consent sends nothing; cancelling a batch keeps completed results", async () => {
  const f = fixture("chatgpt");
  try {
    f.allow(false);
    await f.store.suggest(false);
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.busy, false);
    f.allow(true);
    f.answers.push('{"elements":[{"category":"Props","label":"Revolver","text":"revolver"}]}', new Promise(() => undefined));
    const pending = f.store.suggest(true);
    while (f.requests.length < 2) await new Promise(resolve => setImmediate(resolve));
    f.store.cancel();
    await pending;
    assert.equal(f.cancellations(), 1);
    assert.ok(f.store.rows.some(row => row.label === "Revolver"));
    assert.equal(f.store.error, "");
    assert.equal(f.store.busy, false);
  } finally { f.close(); }
});

test("closing the panel or swapping documents cancels pending work and clears highlights", async () => {
  for (const action of ["close", "swap"]) {
    const f = fixture();
    try {
      f.answers.push(new Promise(() => undefined));
      const pending = f.store.suggest(false);
      while (!f.requests.length) await new Promise(resolve => setImmediate(resolve));
      if (action === "close") f.panel(null);
      else f.swap(DocumentSession.untitled());
      await pending;
      assert.equal(f.cancellations(), 1);
      assert.equal(f.store.busy, false);
      assert.equal(f.decorations.at(-1).length, 0);
    } finally { f.close(); }
  }
});

test("next scene clears review choices and read-only sessions cannot tag", () => {
  const f = fixture();
  try {
    f.store.update(f.store.rows[0]!.id, { label: "Changed name", checked: false });
    f.store.next();
    assert.equal(f.store.sceneIndex, 1);
    assert.equal(f.store.rows.length, 0);
    f.app.editor.setSelection({ paragraphId: f.session.script().paragraphs[0]!.id });
    assert.equal(f.store.rows[0]!.label, "MAYA");
    assert.equal(f.store.rows[0]!.checked, true);
    f.session.setReadOnly(true);
    f.store.tag();
    assert.equal(engine.tagDefinitions(f.session.script()).length, 0);
  } finally { f.close(); }
});

test("tag highlights default on in the panel, and a saved preference governs visibility", async () => {
  const f = fixture();
  const tagged = () => f.decorations.at(-1).filter((mark: any) => mark.className.includes("breakdown-tag")).length;
  try {
    f.store.tag();
    assert.equal(tagged(), 1);
    f.panel(null);
    assert.equal(tagged(), 0);
    await f.app.setSetting("breakdown.showTags", true);
    assert.equal(tagged(), 1);
    await f.app.setSetting("breakdown.showTags", false);
    f.panel("breakdown");
    assert.equal(tagged(), 0);
  } finally { f.close(); }
});

test("a capitalized introduction whose cue is in another scene is tagged, not skipped", async () => {
  const { castSuggestions, scenesOf } = await import("@screenplay/engine");
  const { liveSpans } = await import("../src/renderer/features/breakdown/review.ts");
  const p = (id: string, type: string, text: string) => ({ id, type, runs: [{ text }] }) as any;
  const script = { titlePage: [], paragraphs: [p("h", "sceneHeading", "EXT. RIDGE - DAY"), p("a", "action", "TOMMY MULLEN (18) waits."),
    p("h2", "sceneHeading", "EXT. ROAD - DAY"), p("c", "character", "TOMMY MULLEN"), p("d", "dialogue", "Hi.")] };
  const [row] = castSuggestions(script, 0);
  const review = { ...row!, checked: true, headingId: scenesOf(script.paragraphs)[0]!.headingId };
  assert.equal(liveSpans(script, [review]).size, 1);
});
