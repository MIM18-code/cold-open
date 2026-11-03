import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ModelProgress } from "../src/main/models/ollama.ts";

test("setup downloads use the saved endpoint, skip a second confirmation, pause and resume; Settings still confirms", async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), progress: ModelProgress[] = [], requests: string[] = [];
  let confirmations = 0, finish = false, installed = false;
  const settings = new Map<string, unknown>([["ai.ollama.endpoint", "http://127.0.0.1:1234"]]);
  const result = await build({ entryPoints: [fileURLToPath(new URL("../src/main/services/model-manager.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "native-dialog", setup(plugin) {
      plugin.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fixture" }));
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const dialog = globalThis.dialog;" }));
    } }],
  });
  const transport = async (url: string, init: RequestInit) => {
    requests.push(url);
    if (url.endsWith("/api/tags")) return Response.json({ models: installed ? [{ name: "qwen3.5:4b", size: 3.3e9, digest: "a".repeat(64) }] : [] });
    assert.ok(url.endsWith("/api/pull"));
    assert.equal(JSON.parse(String(init.body)).model, "qwen3.5:4b");
    return new Response(new ReadableStream({ start(controller) {
      const send = (value: unknown) => controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
      send({ status: "pulling", completed: 50, total: 100 });
      if (finish) { installed = true; send({ status: "success" }); controller.close(); }
      else init.signal!.addEventListener("abort", () => controller.error(new Error("Paused")), { once: true });
    } }));
  };
  const module = { exports: {} as { register: (ctx: any) => void } };
  runInNewContext(result.outputFiles[0]!.text, { module, exports: module.exports, require: createRequire(import.meta.url), fetch: transport, AbortController, AbortSignal,
    TextDecoder, TextEncoder, dialog: { showMessageBox: async () => { confirmations++; return { response: 0 }; } } });
  module.exports.register({ paths: { userData: "/unused" }, handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), onQuit: () => {},
    settings,
    broadcast: (_name: string, value: ModelProgress) => progress.push(value), windowOf: () => ({}) });
  const sender = Object.assign(new EventEmitter(), { id: 1 }), event = { sender };
  const pull = handlers.get("models:pull")!, status = handlers.get("models:status")!, cancel = handlers.get("models:cancel")!;
  const paused = pull(event, { fromAiSetup: true });
  const rejected = assert.rejects(paused, /Paused/);
  for (let i = 0; i < 20 && !progress.some((p) => p.completed === 50); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(progress.some((p) => p.completed === 50));
  assert.equal((await status(event, { fromAiSetup: true })).downloading, true);
  cancel(event);
  await rejected;
  assert.equal(progress.at(-1)?.state, "paused");
  assert.equal(confirmations, 0);
  finish = true;
  await pull(event, { fromAiSetup: true });
  assert.equal(progress.at(-1)?.state, "ready");
  assert.equal((await status(event, { fromAiSetup: true })).downloading, false);
  assert.deepEqual(requests, ["http://127.0.0.1:1234/api/pull", "http://127.0.0.1:1234/api/pull", "http://127.0.0.1:1234/api/tags"]);
  const before = requests.length;
  assert.equal(await pull(event), null);
  assert.equal(confirmations, 1);
  assert.equal(requests.length, before);

  // With explicit local setup, use loopback even if a different server was saved. An answering
  // service needs no runtime install. A repeated setup reuses the model already downloaded.
  requests.length = 0;
  installed = false;
  settings.set("ai.model.ollama", "deleted-model");
  await pull(event, { fromAiSetup: true, setupOnMac: true });
  assert.deepEqual(requests.filter(url => url.endsWith("/api/pull")), ["http://127.0.0.1:11434/api/pull"]);
  assert.equal(settings.get("ai.ollama.endpoint"), "http://127.0.0.1:11434");
  assert.equal(settings.get("ai.model.ollama"), undefined);
  requests.length = 0;
  await pull(event, { fromAiSetup: true, setupOnMac: true });
  assert.ok(requests.every(url => url.endsWith("/api/tags")));
});
