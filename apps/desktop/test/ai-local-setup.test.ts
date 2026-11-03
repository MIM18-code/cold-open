import assert from "node:assert/strict";
import { test } from "node:test";
import { localAiSetup } from "../src/main/ai/local-setup.ts";
import { setupStep } from "../src/renderer/features/assistant/setup-state.ts";

const offline = async (): Promise<Response> => { throw new Error("closed port"); };
const tags = (models: { name: string; size?: number }[] = []) => async () => Response.json({ models });

test("missing app, both application folders, and an answering endpoint determine installation", async () => {
  const paths: string[] = [];
  assert.deepEqual(await localAiSetup(undefined, { fetch: offline, home: "/test/writer", exists: (path) => { paths.push(path); return false; } }),
    { installed: false, running: false, model: false });
  assert.deepEqual(paths, ["/Applications/Ollama.app", "/test/writer/Applications/Ollama.app"]);
  for (const app of paths) assert.deepEqual(await localAiSetup(undefined, { fetch: offline, home: "/test/writer", exists: (path) => path === app }),
    { installed: true, running: false, model: false });
  assert.deepEqual(await localAiSetup(undefined, { fetch: tags(), exists: () => false }),
    { installed: true, running: true, model: false });
});

test("readiness checks the configured endpoint and the same usable models as the assistant", async () => {
  let url = "";
  const ready = await localAiSetup("http://127.0.0.1:1234/", { exists: () => false, fetch: async (path) => {
    url = path; return Response.json({ models: [{ name: "qwen3.5:4b", size: 3.3e9 }] });
  } });
  assert.equal(url, "http://127.0.0.1:1234/api/tags");
  assert.deepEqual(ready, { installed: true, running: true, model: true });
  assert.equal((await localAiSetup(undefined, { exists: () => true, fetch: tags([{ name: "mistral:latest" }]) })).model, true);
  assert.equal((await localAiSetup(undefined, { exists: () => true, fetch: tags([{ name: "nomic-embed-text" }]) })).model, false);
  assert.equal((await localAiSetup(undefined, { exists: () => true, fetch: async () => new Response("", { status: 503 }) })).running, false);
});

test("a stalled endpoint is aborted within 1.5 seconds", async () => {
  let signal: AbortSignal | null | undefined;
  // Keep the test alive while AbortSignal's unref'ed deadline fires.
  const keepAlive = setInterval(() => {}, 2000);
  try {
    const state = await localAiSetup(undefined, { exists: () => true, fetch: (_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }) });
    assert.equal(signal?.aborted, true);
    assert.deepEqual(state, { installed: true, running: false, model: false });
  } finally { clearInterval(keepAlive); }
});

test("the sheet advances through installation, start, download and readiness", () => {
  assert.equal(setupStep(null, false), "checking");
  assert.equal(setupStep({ installed: false, running: false, model: false }, false), "not-installed");
  assert.equal(setupStep({ installed: true, running: false, model: false }, false), "not-running");
  assert.equal(setupStep({ installed: false, running: false, model: false }, false, { state: "preparing", status: "Installing" }), "preparing");
  const running = { installed: true, running: true, model: false };
  assert.equal(setupStep(running, false), "no-model");
  assert.equal(setupStep(running, false, { state: "downloading", status: "", completed: 10, total: 100 }), "downloading");
  assert.equal(setupStep(running, false, { state: "paused", status: "" }), "paused");
  assert.equal(setupStep(running, false, { state: "downloading", status: "", completed: 10, total: 100 }), "downloading");
  assert.equal(setupStep(running, false, { state: "verifying", status: "" }), "downloading");
  assert.equal(setupStep({ ...running, model: true }, false), "ready");
  assert.equal(setupStep(running, false, { state: "error", status: "" }), "no-model");
});

test("a ready ChatGPT plan skips local setup at every step", () => {
  for (const local of [null, { installed: false, running: false, model: false }, { installed: true, running: true, model: true }]) {
    assert.equal(setupStep(local, true, { state: "paused", status: "" }), "chatgpt-ready");
  }
});

test("cloud-hosted Ollama models and a deleted model choice don't count as AI on this Mac", async () => {
  // Sol: Ollama's cloud models run on Ollama's servers, so a cloud-only install isn't private local AI.
  const cloud = [{ name: "gpt-oss:120b-cloud" }, { name: "deepseek-v3.1:671b-cloud" }, { name: "qwen3:cloud" }];
  assert.equal((await localAiSetup(undefined, { exists: () => true, fetch: tags(cloud) })).model, false);
  const remote = async () => Response.json({ models: [{ name: "qwen3.5:4b", remote_host: "https://ollama.com:443" }] });
  assert.equal((await localAiSetup(undefined, { exists: () => true, fetch: remote })).model, false);
  // Sol: a selected model that was deleted isn't ready even when another model is installed.
  const installed = tags([{ name: "qwen3.5:4b", size: 3.3e9 }]);
  assert.equal((await localAiSetup(undefined, { exists: () => true, fetch: installed, selected: "llama3:8b" })).model, false);
  assert.equal((await localAiSetup(undefined, { exists: () => true, fetch: installed, selected: "qwen3.5:4b" })).model, true);
});

test("a cloud provider's status doesn't wait for the local probe, and probes are shared for five seconds", async () => {
  const { AiRunner } = await import("../src/main/ai/runner.ts");
  let probes = 0, release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const settings: Record<string, string> = { "ai.provider": "anthropic" };
  const runner = new AiRunner({
    setting: (key: string) => settings[key] as any,
    keys: { has: () => true, encryption: true } as any,
    fetch: (async () => { probes++; await stalled; return Response.json({ models: [{ name: "qwen3.5:4b" }] }); }) as any,
  } as any);
  const started = Date.now();
  const cloud = await runner.status();
  assert.ok(Date.now() - started < 200, "a cloud status returns without waiting for Ollama");
  assert.equal(cloud.providers.find((p) => p.provider === "ollama")!.ready, true, "no answer yet reads as before");
  settings["ai.provider"] = "ollama";
  const local = runner.status(), again = runner.status();
  release();
  assert.equal((await local).providers.find((p) => p.provider === "ollama")!.ready, true);
  await again;
  assert.equal(probes, 1, "concurrent and recent status calls share one probe");
});

test("the setup sheet's fresh check updates the readiness the retried request reads", async () => {
  // Sol: a retry after setup read a cached "not ready" and failed again.
  const { AiRunner } = await import("../src/main/ai/runner.ts");
  let up = false;
  const runner = new AiRunner({
    setting: (key: string) => (key === "ai.provider" ? "ollama" : undefined) as any,
    keys: { has: () => false, encryption: true } as any,
    fetch: (async () => { if (!up) throw new Error("closed"); return Response.json({ models: [{ name: "qwen3.5:4b" }] }); }) as any,
  } as any);
  assert.equal((await runner.status()).providers.find((p) => p.provider === "ollama")!.ready, false);
  up = true;
  assert.equal((await runner.localReadiness("fresh")).model, true);
  assert.equal((await runner.status()).providers.find((p) => p.provider === "ollama")!.ready, true, "within the 5 s cache window");
});

test("a model saved without a tag matches its :latest install", async () => {
  // Codex review: Ollama reads "mistral" as "mistral:latest".
  const installed = tags([{ name: "mistral:latest" }]);
  assert.equal((await localAiSetup(undefined, { exists: () => true, fetch: installed, selected: "mistral" })).model, true);
  assert.equal((await localAiSetup(undefined, { exists: () => true, fetch: installed, selected: "mistral:7b" })).model, false);
});
