// Real provider calls with tiny prompts, for checking the request and stream code against the live APIs. Opt in:
//   SCREENPLAY_LIVE_AI=1 node --test test/ai-live.test.ts
// Keys are read here, in the test process, from the environment or the .env files named below, and are never
// printed. Each provider is skipped when its key is missing.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { listModels, newestModel, streamChat, type HttpProvider } from "../src/main/ai/providers.ts";

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

for (const provider of ["google", "anthropic", "openai"] as const) {
  test(`live: ${provider} lists models and streams a short answer`, { skip: !LIVE && "set SCREENPLAY_LIVE_AI=1", timeout: 120_000 }, async (t) => {
    const apiKey = KEYS[provider]();
    if (!apiKey) return t.skip(`no ${provider} key`);
    const config = { ollamaEndpoint: "", apiKey };
    const signal = new AbortController().signal;
    const models = (await listModels(provider, config, fetch, signal)).map((m) => m.id);
    assert.ok(models.length > 0, "the key lists models");
    // The models the app would pick with no model chosen, one request each.
    for (const tier of ["fast", "smart"] as const) {
      const model = newestModel(provider, tier, models);
      if (tier === "smart" && model === newestModel(provider, "fast", models)) continue;
      assert.ok(models.includes(model), `${model} is offered (${models.length} models listed)`);
      let streamed = "";
      const started = Date.now();
      const text = await streamChat(provider, { model, tier, ...PROMPT, maxTokens: 1024, json: false }, config, fetch, signal, (piece) => (streamed += piece));
      console.log(`  ${provider} ${model}: "${text.trim()}" in ${Date.now() - started} ms`);
      assert.equal(text, streamed);
      assert.match(text, /blue/i);
    }
  });
}
