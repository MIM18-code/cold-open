import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { LocalFormatter, ProviderError, buildMessages, contextWindow, localEndpoint } from "../src/formatter.ts";

const fixture = JSON.parse(readFileSync(new URL("./parity/messages.json", import.meta.url), "utf8"));

test("prompt messages are byte-identical to Writers Block's", () => {
  const messages = buildMessages(fixture.transcript, fixture.context);
  assert.deepEqual(messages, fixture.messages);
  assert.equal(contextWindow(messages, 6000), fixture.window);
});

test("endpoints stay on loopback", () => {
  assert.equal(localEndpoint("http://localhost:11434/"), "http://127.0.0.1:11434");
  assert.throws(() => localEndpoint("https://api.example.com/v1"), ProviderError);
  assert.throws(() => localEndpoint("http://user:pw@127.0.0.1:1234"), ProviderError);
});

test("one repair request, then a saved-transcript failure", async () => {
  const transcript = "Maya waits.";
  const replies = [
    { message: { content: '{"elements":[{"type":"action","text":"Maya waits.","source_quote":"Maya sits.","uncertainty":""}],"omissions":[],"warnings":[]}' }, done: true },
    { message: { content: '{"elements":[{"type":"action","text":"Maya waits.","source_quote":"Maya waits.","uncertainty":""}],"omissions":[],"warnings":[]}' }, done: true },
  ];
  const bodies: any[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  }) as typeof fetch;
  const formatter = new LocalFormatter({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "qwen3.5:4b", localServerConfirmed: true }, fake);
  const proposal = await formatter.format(transcript, {});
  assert.equal(proposal.elements[0]!.source_quote, "Maya waits.");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages.at(-1).role, "user");
  assert.equal(bodies[0].options.num_ctx, 16384);
});

test("cloud-tagged models are refused before any request", async () => {
  const formatter = new LocalFormatter({ provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "gpt-oss:120b-cloud", localServerConfirmed: true },
    (() => assert.fail("no request")) as unknown as typeof fetch);
  await assert.rejects(formatter.format("Maya waits.", {}), /Cloud-tagged/);
});
