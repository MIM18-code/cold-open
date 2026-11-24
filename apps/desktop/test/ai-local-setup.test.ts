import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { localAiSetup } from "../src/main/ai/local-setup.ts";
import { LocalRuntime, ollamaEnvironment } from "../src/main/models/local-runtime.ts";
import { setupStep } from "../src/renderer/features/assistant/setup-state.ts";

const offline = async (): Promise<Response> => { throw new Error("closed port"); };
const tags = (models: { name: string; size?: number }[] = []) => async () => Response.json({ models });

/** A copy of Ollama in the app's own folder that never answers by itself; Ollama on this Mac, if any, is hidden. */
function fakeOllama(t: TestContext) {
  const userData = mkdtempSync(join(tmpdir(), "local-runtime-"));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  const folder = join(userData, "local-ai", "ollama-0.40.13");
  mkdirSync(folder, { recursive: true });
  const pidFile = join(userData, "pid");
  writeFileSync(join(folder, "ollama"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
  chmodSync(join(folder, "ollama"), 0o755);
  const runtime = new LocalRuntime(userData);
  t.after(() => runtime.stop());
  const started = async () => {
    for (let tries = 0; !existsSync(pidFile) && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    return Number(readFileSync(pidFile, "utf8"));
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const gone = async (pid: number) => {
    for (let tries = 0; alive(pid) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
    return !alive(pid);
  };
  return { runtime, started, alive, gone };
}

test("cancelling a local AI start stops the ollama serve it started", async (t) => {
  if (process.platform !== "darwin") { t.skip("the runtime path is macOS only"); return; }
  const { runtime, started, gone } = fakeOllama(t);
  t.mock.method(globalThis, "fetch", offline);
  const controller = new AbortController();
  const start = runtime.start(controller.signal, () => undefined, false);
  const pid = await started();
  controller.abort();
  await assert.rejects(start);
  assert.equal(await gone(pid), true, "ollama serve kept running");
});

test("cancelling while a readiness check is under way still stops the server, even if the check then succeeds", async (t) => {
  if (process.platform !== "darwin") { t.skip("the runtime path is macOS only"); return; }
  const { runtime, started, gone } = fakeOllama(t);
  const controller = new AbortController();
  let calls = 0;
  let probing: (() => void) | undefined;
  const probe = new Promise<void>((resolve) => { probing = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    // The check before starting finds nothing; the first readiness check answers only after the cancel.
    if (++calls === 1) throw new Error("closed port");
    probing!();
    await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
    return Response.json({ models: [] });
  });
  const start = runtime.start(controller.signal, () => undefined, false);
  const pid = await started();
  await probe;
  controller.abort();
  await assert.rejects(start);
  assert.equal(await gone(pid), true, "ollama serve kept running");
});

test("cancelling one start leaves running a server that another start spawned", async (t) => {
  if (process.platform !== "darwin") { t.skip("the runtime path is macOS only"); return; }
  const { runtime, started, alive } = fakeOllama(t);
  t.mock.method(globalThis, "fetch", offline);
  const automatic = new AbortController(), setup = new AbortController();
  const first = runtime.start(automatic.signal, () => undefined, false).catch(() => undefined);
  const pid = await started();
  let waiting = false;
  const second = runtime.start(setup.signal, (message) => { waiting = message.startsWith("Starting"); }, false);
  // Cancel once the second start is waiting on the shared server.
  for (let tries = 0; !waiting && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  setup.abort();
  await assert.rejects(second);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(pid), true, "the other start's server was killed");
  automatic.abort();
  await first;
});

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

test("the Ollama the app starts gets only the environment it needs", () => {
  const env = ollamaEnvironment({
    HOME: "/Users/w", PATH: "/usr/bin", TMPDIR: "/tmp/x", LANG: "en_US.UTF-8", LC_ALL: "C", USER: "w",
    HTTPS_PROXY: "http://proxy:8080", no_proxy: "localhost", OLLAMA_MODELS: "/Volumes/Big/models", OLLAMA_HOST: "0.0.0.0:11434",
    OPENAI_API_KEY: "sk-secret", AWS_SECRET_ACCESS_KEY: "secret", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require /tmp/x.js",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib", MISSING: undefined,
    OLLAMA_LIBRARY_PATH: "/tmp/planted", OLLAMA_ORIGINS: "*", OLLAMA_CLOUD_BASE_URL: "https://example.com", OLLAMA_KEEP_ALIVE: "10m",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "OLLAMA_HOST", "OLLAMA_KEEP_ALIVE", "OLLAMA_MODELS", "OLLAMA_NO_CLOUD", "PATH", "TMPDIR", "USER", "no_proxy"]);
  assert.equal(env.OLLAMA_HOST, "127.0.0.1:11434", "the app's own address wins over one in the environment");
  assert.equal(env.OLLAMA_MODELS, "/Volumes/Big/models");
});
