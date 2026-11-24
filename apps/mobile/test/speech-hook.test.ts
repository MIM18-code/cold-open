import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { resolve } from "node:path";

// Drive useSpeech with stand-ins for React, AppState and the on-device recognizer, so the phase a writer sees can be
// checked against what the recognizer does and does not answer.
const root = resolve(import.meta.dirname, "..");
const stubs: Record<string, string> = {
  react: `let slots = [], cursor = 0;
    export function begin() { cursor = 0; }
    export function unmount() { for (const s of slots) if (s && s.effect) s.cleanup?.(); slots = []; cursor = 0; }
    export function useState(value) { const i = cursor++;
      if (!(i in slots)) slots[i] = typeof value === "function" ? value() : value;
      return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; }
    export function useRef(value) { return useState(() => ({ current: value }))[0]; }
    export function useEffect(fn, deps) { const i = cursor++, old = slots[i];
      if (old && deps.every((d, k) => d === old.deps[k])) return;
      old?.cleanup?.(); slots[i] = { effect: true, deps }; slots[i].cleanup = fn(); }`,
  "react-native": `export const appState = [];
    export const AppState = { addEventListener(_, fn) { appState.push(fn); return { remove() { appState.splice(appState.indexOf(fn), 1); } }; } };`,
  expo: `export const recognizer = { listeners: {}, calls: [], starts: [], startFails: [], auths: [], deferAuth: false,
      addListener(name, fn) { this.listeners[name] = fn; return { remove: () => { delete this.listeners[name]; } }; },
      authorize() { return this.deferAuth ? new Promise(ok => this.auths.push(ok)) : Promise.resolve(true); },
      start() { this.calls.push("start"); return new Promise((ok, fail) => { this.starts.push(ok); this.startFails.push(fail); }); },
      finish() { this.calls.push("finish"); }, cancel() { this.calls.push("cancel"); } };
    export class NativeModule {} export const requireNativeModule = () => recognizer;`,
};
const result = await build({ stdin: { contents: `export { useSpeech } from "./src/useSpeech";
  export { begin, unmount } from "react"; export { appState } from "react-native"; export { recognizer } from "expo";`,
  resolveDir: root },
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: "stubs" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "stubs" }, ({ path }) => ({ contents: stubs[path], resolveDir: root }));
  } }],
});
const hook = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0]!.text).toString("base64"));
const flush = () => new Promise(r => setImmediate(r));
const render = () => { hook.begin(); return hook.useSpeech(() => {}, () => {}); };
function fresh() {
  hook.unmount(); hook.recognizer.calls.length = 0; hook.recognizer.starts.length = 0;
  hook.recognizer.startFails.length = 0; hook.recognizer.auths.length = 0; hook.recognizer.deferAuth = false;
  render();
}

test("switching apps while dictation is starting shows Finishing, not Starting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fresh();
  void render().start();
  await flush();
  assert.equal(render().phase, "starting");
  for (const fn of [...hook.appState]) fn("background");
  assert.equal(render().phase, "finishing");
  hook.recognizer.starts[0]();
  await flush();
  assert.equal(render().phase, "finishing", "the late start answer leaves Finishing until the recognizer ends");
  t.mock.timers.tick(5000);
  hook.unmount();
});

test("a start that answers after the give-up timer and a second press does not show listening for the second", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fresh();
  void render().start();
  await flush();
  render().finish();
  t.mock.timers.tick(5000);
  assert.equal(render().phase, "idle");
  void render().start();
  await flush();
  assert.equal(hook.recognizer.starts.length, 2);
  hook.recognizer.starts[0]();
  await flush();
  assert.equal(render().phase, "starting", "the first start's answer belongs to a take that was given up");
  hook.recognizer.starts[1]();
  await flush();
  assert.equal(render().phase, "listening");
  hook.unmount();
});

test("releasing and pressing again while authorization is pending starts the recognizer once", async () => {
  fresh();
  hook.recognizer.deferAuth = true;
  void render().start();
  await flush();
  render().finish();
  void render().start();
  await flush();
  hook.recognizer.auths[0](true);
  await flush();
  hook.recognizer.auths[1](true);
  await flush();
  assert.equal(hook.recognizer.calls.filter((c: string) => c === "start").length, 1);
  hook.recognizer.starts[0]();
  await flush();
  assert.equal(render().phase, "listening");
  hook.unmount();
});

test("a start that answers after the give-up timer is stopped when the next press was released before starting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fresh();
  void render().start();
  await flush();
  render().finish();
  t.mock.timers.tick(5000);
  hook.recognizer.deferAuth = true;
  void render().start();
  await flush();
  render().finish();
  hook.recognizer.auths[0](true);
  await flush();
  assert.equal(render().phase, "idle");
  const before = hook.recognizer.calls.length;
  hook.recognizer.starts[0]();
  await flush();
  assert.deepEqual(hook.recognizer.calls.slice(before), ["finish"], "the late recognizer is stopped");
  hook.unmount();
});

test("a failed start after release does not leave a give-up timer that cancels the next take", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fresh();
  void render().start();
  await flush();
  render().finish();
  hook.recognizer.startFails[0](new Error("Audio session unavailable"));
  await flush();
  assert.equal(render().phase, "idle");
  // Start a new take within 5 seconds and let the old timer's window pass.
  void render().start();
  await flush();
  hook.recognizer.starts[1]();
  await flush();
  assert.equal(render().phase, "listening");
  t.mock.timers.tick(5000);
  assert.equal(render().phase, "listening");
  assert.equal(hook.recognizer.calls.includes("cancel"), false);
  hook.unmount();
});
