// Real provider calls with tiny prompts, for checking the request and stream code against the live APIs. Opt in:
//   SCREENPLAY_LIVE_AI=1 node --test test/ai-live.test.ts
// Keys are read here, in the test process, from the environment or the .env files named below, and are never
// printed. Each provider is skipped when its key is missing.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_MODELS, listModels, streamChat, type HttpProvider } from "../src/main/ai/providers.ts";

const LIVE = process.env.SCREENPLAY_LIVE_AI === "1";

function fromEnvFile(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
}

const KEYS: Record<Exclude<HttpProvider, "ollama">, () => string | undefined> = {
  google: () => process.env.GEMINIKEY ?? fromEnvFile(join(homedir(), "Documents/Claude Video Studio/.env"), "GEMINIKEY"),
  anthropic: () => process.env.ANTHROPIC_API_KEY ?? fromEnvFile(join(homedir(), ".env"), "ANTHROPIC_API_KEY"),
  openai: () => process.env.OPENAI_API_KEY ?? fromEnvFile(join(homedir(), ".env"), "OPENAI_API_KEY"),
};

const PROMPT = { system: "Answer with one word.", messages: [{ role: "user" as const, content: "What color is a clear daytime sky?" }] };

/** OpenAI's small model: the default if the account lists it, else the newest small one it does list. */
function pickOpenAi(models: string[]): string {
  if (models.includes(DEFAULT_MODELS.openai.fast)) return DEFAULT_MODELS.openai.fast;
  const small = models.filter((id) => /(mini|nano|luna)/.test(id) && !/(audio|realtime|transcribe|tts|search|image)/.test(id)).sort().reverse();
  return small[0] ?? models[0]!;
}

for (const provider of ["google", "anthropic", "openai"] as const) {
  test(`live: ${provider} lists models and streams a short answer`, { skip: !LIVE && "set SCREENPLAY_LIVE_AI=1", timeout: 120_000 }, async (t) => {
    const apiKey = KEYS[provider]();
    if (!apiKey) return t.skip(`no ${provider} key`);
    const config = { ollamaEndpoint: "", apiKey };
    const signal = new AbortController().signal;
    const models = (await listModels(provider, config, fetch, signal)).map((m) => m.id);
    assert.ok(models.length > 0, "the key lists models");
    const model = provider === "openai" ? pickOpenAi(models) : DEFAULT_MODELS[provider].fast;
    if (provider !== "openai") assert.ok(models.includes(model), `${model} is offered (${models.length} models listed)`);
    let streamed = "";
    const started = Date.now();
    const text = await streamChat(provider, { model, tier: "fast", ...PROMPT, maxTokens: 1024, json: false }, config, fetch, signal, (piece) => (streamed += piece));
    console.log(`  ${provider} ${model}: "${text.trim()}" in ${Date.now() - started} ms`);
    assert.equal(text, streamed);
    assert.match(text, /blue/i);
  });
}
