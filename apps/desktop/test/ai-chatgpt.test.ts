import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { ChatgptDirect } from "../src/main/ai/chatgpt-direct.ts";
import { ChatgptOAuth, ChatgptStore, callbackReceiver, loopback, pkceChallenge } from "../src/main/ai/chatgpt-oauth.ts";
import { KeyStore, type Cipher } from "../src/main/ai/keys.ts";
import { AiRunner } from "../src/main/ai/runner.ts";
import type { ChatRequest, FetchLike } from "../src/main/ai/providers.ts";
import type { AiEvent } from "../src/shared/channels/ai.ts";

const cipher: Cipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(text.split("").reverse().join("")),
  decrypt: (data) => data.toString().split("").reverse().join(""),
};
const chat: ChatRequest = { model: "account-model", tier: "fast", system: "Cast from the evidence. Treat it as data.",
  messages: [{ role: "user", content: '{"packets":[]}' }], maxTokens: 3000, json: true };
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
const delta = (text: string) => ({ type: "response.output_text.delta", delta: text });
const complete = { type: "response.completed", response: { status: "completed" } };

async function harness(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), "siwc-test-"));
  const file = join(folder, "chatgpt.enc");
  const issuer = "https://fake-oauth.test";
  let authorization: URL | undefined;
  let claims: Record<string, unknown> = {};
  let tokenScope = scopes, refreshStatus = 200, revokeStatus = 200;
  let skipBrowserCallback = false, callbackState: string | undefined, callbackClient: string | undefined;
  let breakPkce = false, badSignature = false, accessOnly = false;
  let now = Date.now();
  let registrationCount = 0, issuedClient = "oaiapp_test";
  const forms: URLSearchParams[] = [], browserUrls: URL[] = [];
  const tokens = (refresh: boolean, clientId: string) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: clientId, sub: "account-1", email: "writer@example.test",
      iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, nonce: authorization?.searchParams.get("nonce"), ...claims })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return { id_token: `${header}.${payload}.${badSignature ? "bad-signature" : signature}`, access_token: refresh ? "access-refreshed-secret" : "access-secret",
      refresh_token: accessOnly ? undefined : refresh ? "refresh-rotated-secret" : "refresh-secret", expires_in: 3600, token_type: "Bearer", scope: tokenScope };
  };
  const transport: FetchLike = async (url, init) => {
    if (url.endsWith("/.well-known/openid-configuration")) return json({ issuer, authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`, revocation_endpoint: `${issuer}/revoke`, jwks_uri: `${issuer}/jwks` });
    if (url.endsWith("/jwks")) return json({ keys: [jwk] });
    const form = new URLSearchParams(String(init.body));
    forms.push(form);
    if (url.endsWith("/revoke")) return new Response(null, { status: revokeStatus });
    if (form.get("grant_type") === "refresh_token") {
      return json(refreshStatus === 200 ? tokens(true, form.get("client_id")!)
        : { error: refreshStatus === 400 ? "invalid_grant" : "temporarily_unavailable" }, refreshStatus);
    }
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (breakPkce || challenge !== authorization?.searchParams.get("code_challenge")) return json({ error: "invalid_grant" }, 400);
    return json(tokens(false, form.get("client_id")!));
  };
  let deliver!: (params: URLSearchParams) => void;
  const listen: typeof loopback = async (state, signal) => {
    const consume = callbackReceiver(state);
    const callback = new Promise<URLSearchParams>((resolve, reject) => {
      deliver = (params) => { try { resolve(consume(params)); } catch (error) { reject(error); } };
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    void callback.catch(() => undefined);
    return { redirectUri: "http://127.0.0.1:12345/auth/callback", callback };
  };
  const openBrowser = async (url: string) => {
    authorization = new URL(url); browserUrls.push(authorization);
    const client = authorization.searchParams.get("client_id")!;
    if (client === "dynamic_agent_client") {
      registrationCount++;
      issuedClient = registrationCount === 1 ? "oaiapp_test" : `oaiapp_test_${registrationCount}`;
    } else issuedClient = client;
    if (skipBrowserCallback) return;
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ code: "one-use-code", state: callbackState ?? authorization.searchParams.get("state")!,
      client_id: callbackClient ?? issuedClient }).toString();
    deliver(callback.searchParams);
  };
  const store = new ChatgptStore(file, cipher);
  const account = new ChatgptOAuth({ store, fetch: transport, openBrowser, issuer, now: () => now, listen });
  t.after(() => { account.stop(); rmSync(folder, { recursive: true, force: true }); });
  return { account, store, file, folder, forms, browserUrls, issuer, openBrowser, transport, listen,
    setClaims: (value: Record<string, unknown>) => { claims = value; },
    setScope: (value: string) => { tokenScope = value; },
    setRefreshStatus: (value: number) => { refreshStatus = value; },
    accessOnly: () => { accessOnly = true; },
    setRevokeStatus: (value: number) => { revokeStatus = value; },
    setCallbackState: (value: string) => { callbackState = value; },
    setCallbackClient: (value: string) => { callbackClient = value; },
    breakPkce: () => { breakPkce = true; }, fixPkce: () => { breakPkce = false; }, badSignature: () => { badSignature = true; },
    skipCallback: () => { skipBrowserCallback = true; }, advance: (ms: number) => { now += ms; },
  };
}

test("PKCE uses S256 and callback consumption rejects replays and mismatched state", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  for (const state of ["expected", "wrong"]) {
    const receive = callbackReceiver("expected");
    const params = new URLSearchParams({ state, code: "code" });
    if (state === "expected") assert.equal(receive(params), params);
    else assert.throws(() => receive(params), /state did not match/);
    assert.throws(() => receive(params), /already used/);
  }
});

test("real loopback accepts one callback and closes its port", async (t) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let listener: Awaited<ReturnType<typeof loopback>>;
  try { listener = await loopback("expected", controller.signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Sandbox denies loopback listeners"); return; }
    throw error;
  }
  const url = `${listener.redirectUri}?state=expected&code=code`;
  assert.equal((await fetch(url)).status, 200);
  await listener.callback;
  await assert.rejects(fetch(url));
});

test("OAuth validates signature, issuer, audience, expiry, nonce, and state before saving credentials", async (t) => {
  for (const [name, change] of [
    ["state", (h: Awaited<ReturnType<typeof harness>>) => h.setCallbackState("wrong")],
    ["nonce", (h: Awaited<ReturnType<typeof harness>>) => h.setClaims({ nonce: "wrong" })],
    ["issuer", (h: Awaited<ReturnType<typeof harness>>) => h.setClaims({ iss: "https://evil.test" })],
    ["audience", (h: Awaited<ReturnType<typeof harness>>) => h.setClaims({ aud: "wrong-client" })],
    ["expiry", (h: Awaited<ReturnType<typeof harness>>) => h.setClaims({ exp: 1 })],
    ["signature", (h: Awaited<ReturnType<typeof harness>>) => h.badSignature()],
    ["PKCE", (h: Awaited<ReturnType<typeof harness>>) => h.breakPkce()],
  ] as const) await t.test(name, async (t) => {
    const h = await harness(t); change(h);
    await assert.rejects(h.account.signIn());
    assert.equal(h.account.status().signedIn, false);
    assert.equal(h.store.read().profiles.some((p) => p.tokens), false);
    if (name === "state") assert.equal(h.forms.length, 0, "state must be checked before code exchange");
  });
});

test("OAuth registration and tokens stay encrypted; renderer status contains only non-secret account data", async (t) => {
  const h = await harness(t);
  await h.account.signIn();
  const first = h.browserUrls[0]!;
  assert.equal(first.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(first.searchParams.get("agent_name_hint"), "Cold Open");
  assert.equal(first.searchParams.get("code_challenge_method"), "S256");
  assert.equal(first.searchParams.get("scope"), scopes);
  assert.equal(h.forms[0]!.get("redirect_uri"), first.searchParams.get("redirect_uri"));
  assert.equal(h.forms[0]!.get("client_id"), "oaiapp_test");
  assert.equal(h.forms[0]!.has("client_secret"), false);
  assert.equal(h.forms[0]!.get("resource"), "https://api.openai.com/v1");
  assert.equal(statSync(h.file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(h.file, "utf8").includes("access-secret"));
  const keys = new KeyStore(join(h.folder, "keys"), cipher);
  const direct = new ChatgptDirect(h.account, async () => json({ models: [] }));
  const runner = new AiRunner({ setting: () => undefined, keys, fetch, chatgpt: direct });
  const status = await runner.status();
  assert.equal(status.chatgpt.email, "writer@example.test");
  assert.equal(status.chatgpt.planUsageGranted, true);
  assert.ok(!/secret|id_token|refresh_token|clientId|subject/.test(JSON.stringify(status)));
  await h.account.signIn();
  const second = h.browserUrls[1]!;
  assert.equal(second.searchParams.get("client_id"), "oaiapp_test");
  assert.equal(second.searchParams.get("ext_agent_host_id"), first.searchParams.get("ext_agent_host_id"));
  assert.equal(second.searchParams.has("agent_name_hint"), false);
  assert.notEqual(second.searchParams.get("state"), first.searchParams.get("state"));
});

test("identity-only permission stays signed in and never sends inference", async (t) => {
  const h = await harness(t); h.setScope("openid profile email");
  await h.account.signIn();
  assert.equal(h.account.status().signedIn, true);
  assert.equal(h.account.status().planUsageGranted, false);
  let sent = false;
  const direct = new ChatgptDirect(h.account, async () => { sent = true; return json({}); });
  await assert.rejects(direct.stream(chat, new AbortController().signal), /Enable ChatGPT plan usage/);
  assert.equal(sent, false);
});

test("refreshes serialize and rotate tokens together; terminal refresh failures require sign-in", async (t) => {
  const h = await harness(t); await h.account.signIn();
  h.advance(3_550_000);
  const signal = new AbortController().signal;
  assert.deepEqual(await Promise.all([h.account.accessToken(signal), h.account.accessToken(signal)]), ["access-refreshed-secret", "access-refreshed-secret"]);
  const refreshes = h.forms.filter((form) => form.get("grant_type") === "refresh_token");
  assert.equal(refreshes.length, 1); assert.equal(refreshes[0]!.has("scope"), false);
  assert.equal(h.store.read().profiles[0]!.tokens!.refresh, "refresh-rotated-secret");
  h.advance(3_550_000); h.setRefreshStatus(400);
  await assert.rejects(h.account.accessToken(signal), /expired or were revoked/);
  assert.equal(h.account.status().signedIn, false);
});

test("revoke clears tokens, retains host and registration, and reuses them after restart", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const host = h.store.read().hostId;
  await h.account.signOut();
  assert.equal(h.account.status().signedIn, false);
  assert.equal(h.store.read().profiles[0]!.tokens, undefined);
  const revoke = h.forms.find((form) => form.get("token_type_hint") === "refresh_token")!;
  assert.equal(revoke.get("token"), "refresh-secret");
  assert.equal(revoke.get("client_id"), "oaiapp_test");
  const restarted = new ChatgptOAuth({ store: h.store, fetch: h.transport, openBrowser: h.openBrowser, issuer: h.issuer, listen: h.listen });
  t.after(() => restarted.stop());
  await restarted.signIn();
  assert.equal(h.browserUrls.at(-1)!.searchParams.get("client_id"), "oaiapp_test");
  assert.equal(h.browserUrls.at(-1)!.searchParams.get("ext_agent_host_id"), host);
  assert.equal(h.browserUrls.at(-1)!.searchParams.has("id_token_hint"), false);
});

test("a failing remote revoke retries with backoff, then clears locally and points to ChatGPT settings", async (t) => {
  const h = await harness(t); await h.account.signIn(); h.setRevokeStatus(503);
  await h.account.signOut();
  assert.equal(h.forms.filter((form) => form.has("token_type_hint")).length, 6);
  assert.equal(h.store.read().profiles[0]!.tokens, undefined);
  assert.match(h.account.status().note!, /Remote revocation was not confirmed/);
});

test("returning registration and subject mismatches preserve the active account", async (t) => {
  const h = await harness(t); await h.account.signIn();
  h.setCallbackClient("different-client");
  await assert.rejects(h.account.signIn(), /registration did not match/);
  assert.equal(h.account.status().signedIn, true);
  h.setCallbackClient("oaiapp_test"); h.setClaims({ sub: "different-account" });
  await assert.rejects(h.account.signIn(), /different account/);
  assert.equal(h.store.read().profiles[0]!.subject, "account-1");
});

test("sign-in cancellation refuses the pending callback and never saves tokens", async (t) => {
  const h = await harness(t); h.skipCallback();
  const signingIn = h.account.signIn();
  while (!h.browserUrls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  await h.account.signOut();
  await assert.rejects(signingIn, /Cancelled/);
  assert.equal(h.account.status().signedIn, false);
});

test("model discovery uses the account catalog, labels, and server order", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const calls: { url: string; init: RequestInit }[] = [];
  const direct = new ChatgptDirect(h.account, async (url, init) => {
    calls.push({ url, init });
    return json({ models: [{ slug: "second", display_name: "Second", visibility: "list" },
      { slug: "hidden", display_name: "Hidden", visibility: "hide" }, { slug: "first", display_name: "First", visibility: "list" }] });
  });
  assert.deepEqual(await direct.models(new AbortController().signal), [{ id: "second", label: "Second" }, { id: "first", label: "First" }]);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/models");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer access-secret");
});

test("a model catalog of several megabytes loads, and is fetched once per account for a few minutes", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let fetched = 0;
  const instructions = "x".repeat(400_000);
  const direct = new ChatgptDirect(h.account, async () => {
    fetched++;
    return json({ models: Array.from({ length: 5 }, (_, index) => ({ slug: `m${index}`, display_name: `Model ${index}`, visibility: "list", base_instructions: instructions })) });
  });
  const signal = new AbortController().signal;
  assert.equal((await direct.models(signal)).length, 5);
  assert.equal((await direct.models(signal)).length, 5);
  assert.equal(fetched, 1);
});

test("Responses request has only supported fields and returns validated JSON after completion", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let body: Record<string, unknown> = {};
  const direct = new ChatgptDirect(h.account, async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init.redirect, "error"); body = JSON.parse(String(init.body));
    return sse(delta('{"assignments":'), delta("[]}"), complete);
  });
  assert.equal(await direct.stream(chat, new AbortController().signal), '{"assignments":[]}');
  assert.deepEqual(Object.keys(body).sort(), ["input", "model", "store", "stream"]);
  assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.equal((body.input as { role: string }[])[0]!.role, "developer");
  for (const field of ["tools", "tool_choice", "temperature", "max_output_tokens", "max_tokens"]) assert.ok(!(field in body));
});

test("ChatGPT function tools use a namespace and resend calls, results and encrypted reasoning", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const tools = [{ name: "read_scene", description: "Read a scene", parameters: { type: "object", properties: { scene: { type: "string" } }, required: ["scene"] } }];
  const bodies: Record<string, any>[] = [];
  const reasoning = { type: "reasoning", id: "rs1", encrypted_content: "encrypted", summary: [] };
  const functionCall = { type: "function_call", call_id: "call1", namespace: "screenplay", name: "read_scene", arguments: '{"scene":"12"}' };
  const direct = new ChatgptDirect(h.account, async (_url, init) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.deepEqual(body.tools, [{ type: "namespace", name: "screenplay", description: "Read the screenplay and propose edits.", tools: [{ type: "function", ...tools[0], strict: false }] }]);
    for (const field of ["previous_response_id", "temperature", "max_output_tokens", "max_tool_calls", "conversation", "background"]) assert.ok(!(field in body), field);
    if (bodies.length === 1) return sse({ type: "response.output_item.added", item: { ...functionCall, arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"scene":' },
      { type: "response.completed", response: { status: "completed", output: [reasoning, functionCall] } });
    return sse(delta("Scene 12."), { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Scene 12." }] }] } });
  });
  const turn = await direct.turn({ ...chat, json: false, tools }, new AbortController().signal);
  assert.equal(turn.toolCalls![0]!.name, "read_scene");
  assert.deepEqual(turn.toolCalls![0]!.arguments, { scene: "12" });
  const final = await direct.turn({ ...chat, json: false, tools, messages: [...chat.messages,
    { role: "assistant", content: "", toolCalls: turn.toolCalls, reasoning: turn.reasoning },
    { role: "tool", name: "read_scene", toolCallId: "call1", content: "Scene text" }] }, new AbortController().signal);
  assert.equal(final.text, "Scene 12.");
  assert.deepEqual(bodies[1]!.input.slice(-3), [reasoning, functionCall, { type: "function_call_output", call_id: "call1", output: "Scene text" }]);
  assert.deepEqual(bodies[0]!.include, ["reasoning.encrypted_content"]);
});

test("ChatGPT validates function names and arguments, and trims a batch past the limit, before returning tools", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const tools = [{ name: "list_scenes", description: "List scenes", parameters: { type: "object", properties: {} } }];
  const valid = { type: "function_call", call_id: "c", name: "list_scenes", arguments: "{}" };
  for (const output of [[{ ...valid, name: "read_file" }], [{ ...valid, arguments: "{bad" }], [{ ...valid, arguments: "[]" }],
    [{ ...valid, arguments: JSON.stringify({ text: "x".repeat(32_000) }) }]]) {
    const direct = new ChatgptDirect(h.account, async () => sse({ type: "response.completed", response: { status: "completed", output } }));
    await assert.rejects(direct.turn({ ...chat, tools, json: false }, new AbortController().signal), (error: Error) => "code" in error && error.code === "tool-parse");
  }
  // Past the per-turn limit, the first calls run and the rest are counted for the model to ask again.
  const nine = Array.from({ length: 9 }, (_, index) => ({ ...valid, call_id: String(index) }));
  const direct = new ChatgptDirect(h.account, async () => sse({ type: "response.completed", response: { status: "completed", output: nine } }));
  const turn = await direct.turn({ ...chat, tools, json: false }, new AbortController().signal);
  assert.equal(turn.toolCalls!.length, 8);
  assert.equal(turn.skippedCalls, 1);
});

test("ChatGPT never returns tool calls from an incomplete stream", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const tools = [{ name: "list_scenes", description: "List scenes", parameters: { type: "object", properties: {} } }];
  const direct = new ChatgptDirect(h.account, async () => sse({ type: "response.output_item.done", item: { type: "function_call", call_id: "c", name: "list_scenes", arguments: "{}" } }));
  await assert.rejects(direct.turn({ ...chat, tools, json: false }, new AbortController().signal), /before completion/);
});

test("partial, malformed, failed, incomplete and invalid-JSON streams never produce a usable result", async (t) => {
  const h = await harness(t); await h.account.signIn();
  for (const response of [sse(delta('{}')), sse(delta('{}'), { type: "response.failed", response: { error: { code: "server_error" } } }),
    sse(delta('{}'), { type: "response.incomplete" }), sse(delta('bad json'), complete), sse(delta('[]'), complete),
    new Response("data: not-json\n\n"), new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"{}"}\n\n'));
      controller.error(new Error("socket reset"));
    } }))]) {
    const direct = new ChatgptDirect(h.account, async () => response);
    await assert.rejects(direct.stream(chat, new AbortController().signal));
  }
});

test("a valid JSON delta stays pending until response.completed", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const direct = new ChatgptDirect(h.account, async () => new Response(new ReadableStream({ start(c) { controller = c; } })));
  let finished = false;
  const result = direct.stream(chat, new AbortController().signal).then((text) => { finished = true; return text; });
  await new Promise((resolve) => setImmediate(resolve));
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta('{}'))}\n\n`));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(complete)}\n\n`));
  assert.equal(await result, '{}');
});

test("HTTP and streamed plan exhaustion pause future requests until explicit resume", async (t) => {
  for (const streamed of [false, true]) await t.test(String(streamed), async (t) => {
    const h = await harness(t); await h.account.signIn();
    let requests = 0;
    const failure = { code: "subscription_sharing_usage_limit_exceeded" };
    const direct = new ChatgptDirect(h.account, async () => {
      requests++;
      return streamed ? sse(delta('{}'), { type: "response.failed", response: { error: failure } }) : json({ error: failure }, 429);
    });
    await assert.rejects(direct.stream(chat, new AbortController().signal), /paused/);
    await assert.rejects(direct.stream(chat, new AbortController().signal), /paused/);
    assert.equal(requests, 1); assert.equal(h.account.status().paused, true);
    assert.equal(h.store.read().profiles[0]!.paused, true);
    h.account.resume(); assert.equal(h.account.status().paused, false);
  });
});

test("cancellation and sign-out interrupt a stalled stream without returning partial text", async (t) => {
  for (const signOut of [false, true]) await t.test(String(signOut), async (t) => {
    const h = await harness(t); await h.account.signIn();
    let cancelled = false, started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const direct = new ChatgptDirect(h.account, async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta('{}'))}\n\n`)); started(); },
      cancel() { cancelled = true; },
    })));
    const controller = new AbortController();
    const result = direct.stream(chat, controller.signal);
    const rejected = assert.rejects(result, /Cancelled/);
    await ready;
    if (signOut) await h.account.signOut(); else controller.abort();
    await rejected; assert.equal(cancelled, true);
  });
});

test("input and response bytes are bounded; a 401 keeps the credentials and renews access next time", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let calls = 0;
  const direct = new ChatgptDirect(h.account, async () => { calls++; return new Response("x".repeat(2 * 1024 * 1024 + 1)); });
  await assert.rejects(direct.stream({ ...chat, system: "x".repeat(400_001) }, new AbortController().signal), /too large/);
  assert.equal(calls, 0);
  await assert.rejects(direct.stream(chat, new AbortController().signal), /too much data/);
  const denied = new ChatgptDirect(h.account, async () => new Response(JSON.stringify({ detail: "not accepted" }), { status: 401, headers: { "x-request-id": "req_123" } }));
  await assert.rejects(denied.stream(chat, new AbortController().signal), /did not accept the access token \(HTTP 401, not accepted, request ID req_123\)/);
  // OpenAI: never erase credentials over a 401; the next request refreshes and the refresh result decides.
  assert.equal(h.account.status().signedIn, true);
  assert.equal(h.store.read().profiles[0]!.tokens!.expiresAt, 0);
});

test("runner chooses only the configured route, discovers models, and emits no partial ChatGPT output", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let calls = 0;
  let failed = false;
  const transport: FetchLike = async (url) => {
    calls++;
    return url.endsWith("/models") ? json({ models: [{ slug: "from-account", display_name: "Account model", visibility: "list" }] })
      : failed ? sse(delta('{}')) : sse(delta('{}'), complete);
  };
  const settings: Record<string, unknown> = { "ai.provider": "chatgpt" };
  const runner = new AiRunner({ setting: (key) => settings[key] as never, keys: new KeyStore(join(h.folder, "keys"), cipher),
    fetch: transport, chatgpt: new ChatgptDirect(h.account, transport) });
  const run = async (id: string) => {
    const events: AiEvent[] = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const started = await runner.start("owner", { id, tier: "fast", system: chat.system, messages: chat.messages, json: true }, (event) => { events.push(event); if (event.type !== "delta") finish(); });
    await done; return { started, events };
  };
  const good = await run("good"); assert.equal(good.started.model, "from-account");
  assert.deepEqual(good.events.map((event) => event.type), ["done"]);
  failed = true;
  assert.deepEqual((await run("bad")).events.map((event) => event.type), ["error"]);
  settings["ai.model.chatgpt"] = "vanished-model";
  await assert.rejects(run("missing"), /no longer available/);
  settings["ai.provider"] = "ollama"; settings["ai.model.ollama"] = "local";
  await run("local");
  assert.ok(calls > 0);
});

test("profiles isolate registrations and cancel work when the active account changes", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const first = h.account.status().activeProfile!;
  const firstSignal = h.account.signal;
  await h.account.signIn({ newProfile: true });
  const second = h.account.status().activeProfile!;
  assert.notEqual(second, first);
  assert.equal(h.account.status().profiles!.length, 2);
  const profiles = h.store.read().profiles;
  assert.notEqual(profiles[0]!.clientId, profiles[1]!.clientId);
  assert.equal(firstSignal.aborted, true);
  const secondSignal = h.account.signal;
  h.account.select(first);
  assert.equal(secondSignal.aborted, true);
  await h.account.signOut();
  assert.equal(h.store.read().profiles.find((p) => p.id === first)!.tokens, undefined);
  assert.ok(h.store.read().profiles.find((p) => p.id === second)!.tokens);
  h.account.select(second);
  assert.equal(h.account.status().signedIn, true);
});

test("status never asks the keychain when nothing is saved, and saving asks once", async () => {
  // In the app, asking whether encryption is available reads the macOS keychain, and a keychain prompt holds the main process.
  const folder = mkdtempSync(join(tmpdir(), "ai-keychain-"));
  let asked = 0;
  const counting: Cipher = { ...cipher, available: () => (asked++, true) };
  const keys = new KeyStore(join(folder, "keys"), counting);
  const account = new ChatgptOAuth({ store: new ChatgptStore(join(folder, "chatgpt.enc"), counting), fetch: async () => json({}), openBrowser: async () => undefined });
  const runner = new AiRunner({ setting: () => undefined, keys, fetch: async () => json({}), chatgpt: new ChatgptDirect(account, async () => json({})) });
  const status = await runner.status();
  assert.equal(asked, 0);
  assert.equal(status.encryption, true);
  assert.equal(status.chatgpt.available, true);
  keys.set("openai", "sk-test");
  assert.equal(asked, 1);
  await runner.status();
  assert.equal(asked, 1);
  const refused = new KeyStore(join(folder, "refused"), { ...cipher, available: () => false });
  assert.throws(() => refused.set("openai", "k"), /can't encrypt/);
  assert.equal(refused.encryption, false, "after a refusal, status reports it");
});

test("a saved connection the keychain refuses is asked about once, and signing in asks again", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let asked = 0, allow = false;
  const refusing: Cipher = { ...cipher, available: () => (asked++, allow) };
  const account = new ChatgptOAuth({ store: new ChatgptStore(h.file, refusing), fetch: h.transport, openBrowser: h.openBrowser, issuer: h.issuer, listen: h.listen });
  assert.match(account.status().note ?? "", /cannot unlock/);
  account.status(); account.status();
  assert.equal(asked, 1, "status does not ask the keychain again");
  await assert.rejects(account.signIn(), /cannot encrypt/);
  assert.match(account.status().note ?? "", /cannot (encrypt|unlock)/, "the refusal reaches the user");
  const after = asked; account.status();
  assert.equal(asked, after);
  allow = true;
  assert.ok(await account.access(new AbortController().signal), "a request can unlock it");
  assert.equal(account.status().signedIn, true, "and status follows");
  await account.signIn();
  assert.equal(account.status().signedIn, true);
});

test("encrypted storage is required; an unavailable cipher never opens the browser", async (t) => {
  const h = await harness(t);
  const store = new ChatgptStore(h.file, { ...cipher, available: () => false });
  const account = new ChatgptOAuth({ store, fetch: h.transport, openBrowser: h.openBrowser, issuer: h.issuer, listen: h.listen });
  await assert.rejects(account.signIn(), /cannot encrypt/);
  assert.equal(h.browserUrls.length, 0);
});

test("timeout and concurrency bounds stop uncompleted work", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let cancelled = 0;
  const direct = new ChatgptDirect(h.account, async () => new Response(new ReadableStream({ cancel() { cancelled++; } })), 30);
  const signal = new AbortController().signal;
  const first = direct.stream(chat, signal), second = direct.stream(chat, signal);
  const bounded = Promise.all([assert.rejects(first, /timed out/), assert.rejects(second, /timed out/)]);
  await assert.rejects(direct.stream(chat, signal), /already running/);
  // AbortSignal.timeout does not keep the event loop alive on its own.
  const keepAlive = setTimeout(() => undefined, 1000);
  try { await bounded; } finally { clearTimeout(keepAlive); }
  assert.equal(cancelled, 2);
});

test("cancelling Add account preserves the validated active account and its tokens", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const active = h.account.status().activeProfile;
  h.skipCallback();
  const pending = h.account.signIn({ newProfile: true });
  while (h.browserUrls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  h.account.cancelSignIn();
  await assert.rejects(pending, /Cancelled/);
  assert.equal(h.account.status().activeProfile, active);
  assert.equal(h.account.status().signedIn, true);
  assert.equal(h.store.read().profiles[0]!.tokens!.access, "access-secret");
});

test("temporary usage and refresh failures preserve the renewable account", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const direct = new ChatgptDirect(h.account, async () => sse(delta('{}'), {
    type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } },
  }));
  await assert.rejects(direct.stream(chat, new AbortController().signal), /temporarily unavailable/);
  assert.equal(h.account.status().signedIn, true);
  assert.equal(h.account.status().paused, false);
  h.advance(3_550_000); h.setRefreshStatus(503);
  await assert.rejects(h.account.accessToken(new AbortController().signal), /renew access/);
  assert.equal(h.account.status().signedIn, true);
  assert.equal(h.store.read().profiles[0]!.tokens!.refresh, "refresh-secret");
});

test("runner cancellation remains scoped to the window that owns the ChatGPT request", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const readers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const transport: FetchLike = async (url) => url.endsWith("/models")
    ? json({ models: [{ slug: "fixture", display_name: "Fixture", visibility: "list" }] })
    : new Response(new ReadableStream({ start(controller) { readers.push(controller); } }));
  const runner = new AiRunner({ setting: (key) => (key === "ai.provider" ? "chatgpt" : undefined) as never,
    keys: new KeyStore(join(h.folder, "keys"), cipher), fetch: transport, chatgpt: new ChatgptDirect(h.account, transport) });
  const events: { owner: string; event: AiEvent }[] = [];
  const start = (owner: string) => runner.start(owner, { id: "same-id", tier: "fast", json: true,
    system: chat.system, messages: chat.messages }, (event) => events.push({ owner, event }));
  await start("one"); await start("two");
  while (readers.length < 2) await new Promise((resolve) => setImmediate(resolve));
  runner.cancelOwner("one");
  while (!events.length) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0]!.owner, "one");
  assert.equal(events[0]!.event.type, "error");
  assert.equal(events.some((entry) => entry.owner === "two"), false);
  readers[1]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta('{}'))}\n\ndata: ${JSON.stringify(complete)}\n\n`));
  while (events.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[1]!.owner, "two"); assert.equal(events[1]!.event.type, "done");
});


test("sign-out revokes access-only grants and warns when their remote revocation fails", async (t) => {
  for (const status of [200, 503]) {
    const h = await harness(t);
    h.accessOnly();
    await h.account.signIn();
    h.setRevokeStatus(status);
    await h.account.signOut();
    const revocations = h.forms.filter((form) => form.has("token_type_hint"));
    assert.equal(revocations.length, status === 200 ? 1 : 3);
    assert.equal(revocations[0]!.get("token"), "access-secret");
    assert.equal(revocations[0]!.get("token_type_hint"), "access_token");
    assert.equal(revocations[0]!.get("client_id"), "oaiapp_test");
    assert.equal(h.store.read().profiles[0]!.tokens, undefined);
    if (status !== 200) assert.match(h.account.status().note!, /Remote revocation was not confirmed/);
  }
});

test("sign-out revokes both access and refresh tokens", async (t) => {
  const h = await harness(t);
  await h.account.signIn();
  await h.account.signOut();
  assert.deepEqual(h.forms.filter((form) => form.has("token_type_hint"))
    .map((form) => [form.get("token_type_hint"), form.get("token")]).sort(), [
    ["access_token", "access-secret"], ["refresh_token", "refresh-secret"],
  ]);
});

test("only OpenAI's terminal refresh codes clear credentials; invalid_client keeps them", async (t) => {
  for (const [code, cleared] of [["refresh_token_reused", true], ["token_expired", true], ["invalid_client", false], ["temporarily_unavailable", false]] as const) {
    const h = await harness(t); await h.account.signIn();
    h.advance(3_550_000);
    const account = h.account as any, original = account.deps.fetch;
    account.deps.fetch = async (url: string, init: RequestInit) => String(init?.body ?? "").includes("grant_type=refresh_token")
      ? new Response(JSON.stringify({ error: code }), { status: 400 }) : original(url, init);
    await assert.rejects(h.account.accessToken(new AbortController().signal));
    assert.equal(h.account.status().signedIn, !cleared, code);
  }
});

test("a 401 renews once; a 401 right after renewal reports the account instead of looping", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const denied = new ChatgptDirect(h.account, async (url, init) => String(url).includes("/oauth/") || String(init?.body ?? "").includes("grant_type")
    ? (h.account as any).deps.fetch(url, init) : new Response(JSON.stringify({ error: { code: "subscription_sharing_invalid_user" } }), { status: 401 }));
  await assert.rejects(denied.stream(chat, new AbortController().signal), /did not accept the access token \(HTTP 401, subscription_sharing_invalid_user\)/);
  await assert.rejects(denied.stream(chat, new AbortController().signal), /still refuses this account/);
  assert.equal(h.account.status().signedIn, true);
});

test("nothing renews or uses the tokens while sign-out runs", async (t) => {
  const h = await harness(t); await h.account.signIn();
  h.setRevokeStatus(503);
  const out = h.account.signOut();
  await assert.rejects(h.account.accessToken(new AbortController().signal), /Signing out/);
  await out;
  assert.equal(h.store.read().profiles[0]!.tokens, undefined);
});

test("a token rotated by a renewal already in flight is the one sign-out revokes", async (t) => {
  const h = await harness(t); await h.account.signIn();
  h.advance(3_550_000);
  const renewing = h.account.accessToken(new AbortController().signal).catch(() => undefined);
  await h.account.signOut();
  await renewing;
  const revoked = h.forms.filter((form) => form.get("token_type_hint") === "refresh_token").map((form) => form.get("token"));
  assert.deepEqual(revoked, ["refresh-rotated-secret"]);
  assert.equal(h.store.read().profiles[0]!.tokens, undefined);
});

test("an ID token without iat is refused, as OpenAI's verification example requires", async (t) => {
  const h = await harness(t); h.setClaims({ iat: undefined });
  await assert.rejects(h.account.signIn(), /identity could not be verified/);
  assert.equal(h.account.status().signedIn, false);
});

test("text OpenAI sends back never carries a token into the message the app shows", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const echo = new ChatgptDirect(h.account, async () => new Response(JSON.stringify({ detail: "Bearer access-secret-0123456789abcdefghij rejected for eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0aaaa.c2lnbmF0dXJlc2lnbmF0dXJl" }), { status: 403, headers: { "x-request-id": "req_ok" } }));
  await assert.rejects(echo.stream(chat, new AbortController().signal), (error: Error) => {
    assert.doesNotMatch(error.message, /access-secret|eyJ/);
    assert.match(error.message, /HTTP 403/); assert.match(error.message, /req_ok/);
    return true;
  });
  const odd = new ChatgptDirect(h.account, async () => new Response(JSON.stringify({ error: { code: "refresh-secret-token-value-that-is-long-enough" } }), { status: 400, headers: { "x-request-id": "bad id with spaces" } }));
  await assert.rejects(odd.stream(chat, new AbortController().signal), (error: Error) => {
    assert.doesNotMatch(error.message, /refresh-secret|bad id/);
    return true;
  });
});

test("a registration whose code exchange failed is reused by the next sign-in, not registered again", async (t) => {
  const h = await harness(t); h.breakPkce();
  await assert.rejects(h.account.signIn());
  assert.equal(h.browserUrls[0]!.searchParams.get("client_id"), "dynamic_agent_client");
  h.fixPkce();
  await h.account.signIn();
  const retry = h.browserUrls[1]!;
  assert.equal(retry.searchParams.get("client_id"), "oaiapp_test", "the issued client ID retained for the attempt");
  assert.equal(retry.searchParams.has("agent_name_hint"), false);
  assert.equal(h.account.status().signedIn, true);
  assert.equal(h.account.status().profiles?.length ?? 1, 1, "no second registration");
});

test("sign-out stops inference at once even while a renewal is still settling", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let releaseRefresh: (() => void) | undefined;
  const slow: FetchLike = async (url, init) => {
    if (new URLSearchParams(String(init?.body ?? "")).get("grant_type") === "refresh_token") await new Promise<void>((resolve) => { releaseRefresh = resolve; });
    return h.transport(url, init);
  };
  const account = new ChatgptOAuth({ store: h.store, fetch: slow, openBrowser: h.openBrowser, issuer: h.issuer, listen: h.listen });
  const direct = new ChatgptDirect(account, async () => new Response(new ReadableStream({ start() {} })));
  let settled = false;
  const streaming = direct.stream(chat, new AbortController().signal).then(() => "answer", (error: Error) => error).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  account.expireAccess();
  const renewing = account.accessToken(new AbortController().signal).catch(() => undefined);
  for (let tries = 0; !releaseRefresh && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(releaseRefresh, "a renewal is on the wire");
  const out = account.signOut();
  for (let tries = 0; !settled && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(settled, "the stream ended before the renewal settled");
  assert.ok((await streaming) instanceof Error, "and returned no answer");
  releaseRefresh!(); await renewing; await out;
  assert.equal(account.status().signedIn, false);
});

test("an opaque token echoed back in a header or a code is redacted from the message the app shows", async (t) => {
  const h = await harness(t); await h.account.signIn();
  const echo = new ChatgptDirect(h.account, async () => new Response(JSON.stringify({ error: { code: "access-secret" } }), { status: 400, headers: { "x-request-id": "access-secret" } }));
  await assert.rejects(echo.stream(chat, new AbortController().signal), (error: Error) => {
    assert.doesNotMatch(error.message, /access-secret/);
    return true;
  });
  assert.equal(h.account.redact("saw refresh-secret and access-secret"), "saw [redacted] and [redacted]");
});

test("a renewal with the signing keys down keeps the session and the rotated refresh token", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let keysDown = false;
  const flaky: FetchLike = async (url, init) => keysDown && String(url).endsWith("/jwks") ? new Response("busy", { status: 503 }) : h.transport(url, init);
  const account = new ChatgptOAuth({ store: h.store, fetch: flaky, openBrowser: h.openBrowser, issuer: h.issuer, listen: h.listen });
  account.expireAccess(); keysDown = true;
  assert.equal(await account.accessToken(new AbortController().signal), "access-refreshed-secret");
  assert.equal(account.status().signedIn, true, "a key outage is not an identity failure");
  assert.equal(h.store.read().profiles[0]!.tokens!.refresh, "refresh-rotated-secret", "the rotated token was saved");
});

test("a renewal whose ID token fails verification ends the session", async (t) => {
  const h = await harness(t); await h.account.signIn();
  h.badSignature();
  h.advance(3_550_000);
  await assert.rejects(h.account.accessToken(new AbortController().signal), /identity could not be verified/);
  assert.equal(h.account.status().signedIn, false);
});

test("sign-in with the signing keys down asks to try again and saves nothing", async (t) => {
  const h = await harness(t);
  const account = new ChatgptOAuth({ store: h.store, fetch: async (url, init) => String(url).endsWith("/jwks") ? new Response("busy", { status: 503 }) : h.transport(url, init),
    openBrowser: h.openBrowser, issuer: h.issuer, listen: h.listen });
  await assert.rejects(account.signIn(), /signing keys could not be fetched/);
  assert.equal(account.status().signedIn, false);
  assert.ok(!h.store.read().profiles.some((p) => p.tokens), "no tokens were saved");
});

test("while a renewed token's identity check runs, other callers wait for it instead of using the token", async (t) => {
  const h = await harness(t); await h.account.signIn();
  let releaseKeys: (() => void) | undefined;
  const slowKeys: FetchLike = async (url, init) => {
    if (String(url).endsWith("/jwks")) await new Promise<void>((resolve) => { releaseKeys = resolve; });
    return h.transport(url, init);
  };
  const account = new ChatgptOAuth({ store: h.store, fetch: slowKeys, openBrowser: h.openBrowser, issuer: h.issuer, listen: h.listen });
  account.expireAccess();
  const first = account.accessToken(new AbortController().signal);
  for (let tries = 0; !releaseKeys && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(releaseKeys, "the identity check is waiting on the keys");
  assert.equal(h.store.read().profiles[0]!.tokens!.unverified, true, "saved, but marked unverified");
  let secondDone = false;
  const second = account.accessToken(new AbortController().signal).finally(() => { secondDone = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondDone, false, "the second caller did not take the unverified token");
  releaseKeys!();
  assert.deepEqual(await Promise.all([first, second]), ["access-refreshed-secret", "access-refreshed-secret"]);
  assert.equal(h.store.read().profiles[0]!.tokens!.unverified, undefined);
});

test("switching accounts mid-renewal lets the renewal settle, so the account left keeps its rotated token", async (t) => {
  const h = await harness(t); await h.account.signIn();
  await h.account.signIn({ newProfile: true });
  const [left, other] = h.store.read().profiles;
  h.account.select(left!.id);
  let releaseRefresh: (() => void) | undefined;
  const slow: FetchLike = async (url, init) => {
    if (new URLSearchParams(String(init?.body ?? "")).get("grant_type") === "refresh_token") await new Promise<void>((resolve) => { releaseRefresh = resolve; });
    return h.transport(url, init);
  };
  const account = new ChatgptOAuth({ store: h.store, fetch: slow, openBrowser: h.openBrowser, issuer: h.issuer, listen: h.listen });
  account.expireAccess();
  const renewing = account.accessToken(new AbortController().signal).catch((error: Error) => error);
  for (let tries = 0; !releaseRefresh && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  account.select(other!.id);
  releaseRefresh!();
  await renewing;
  assert.equal(h.store.read().profiles.find((p) => p.id === left!.id)!.tokens!.refresh, "refresh-rotated-secret");
});

test("a renewal that comes back terminal after an account switch clears only the account it ran for", async (t) => {
  const h = await harness(t); await h.account.signIn();
  await h.account.signIn({ newProfile: true });
  const [left, other] = h.store.read().profiles;
  h.account.select(left!.id);
  let releaseRefresh: (() => void) | undefined;
  const slow: FetchLike = async (url, init) => {
    if (new URLSearchParams(String(init?.body ?? "")).get("grant_type") === "refresh_token") {
      await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return h.transport(url, init);
  };
  const account = new ChatgptOAuth({ store: h.store, fetch: slow, openBrowser: h.openBrowser, issuer: h.issuer, listen: h.listen });
  account.expireAccess();
  const renewing = account.accessToken(new AbortController().signal).catch((error: Error) => error);
  for (let tries = 0; !releaseRefresh && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  account.select(other!.id);
  releaseRefresh!();
  await renewing;
  const saved = h.store.read().profiles;
  assert.equal(saved.find((p) => p.id === left!.id)!.tokens, undefined, "the account the renewal ran for is cleared");
  assert.ok(saved.find((p) => p.id === other!.id)!.tokens, "the account switched to keeps its tokens");
  assert.equal(account.status().signedIn, true);
});

test("a usage limit or 401 is applied to the account that sent the request, even after a switch", async (t) => {
  const h = await harness(t); await h.account.signIn();
  await h.account.signIn({ newProfile: true });
  const [sender, other] = h.store.read().profiles;
  h.account.select(sender!.id);
  const sent = await h.account.access(new AbortController().signal);
  assert.equal(sent.profileId, sender!.id);
  h.account.select(other!.id);
  // A switch also cancels requests in flight; these are the calls a response that slipped through would make.
  h.account.pause(sent.profileId);
  assert.equal(h.account.expireAccess(sent.profileId, sent.token), true);
  const saved = h.store.read().profiles;
  const a = saved.find((p) => p.id === sender!.id)!, b = saved.find((p) => p.id === other!.id)!;
  assert.equal(a.paused, true); assert.ok(!b.paused, "the account switched to is not paused");
  assert.equal(a.tokens!.expiresAt, 0); assert.notEqual(b.tokens!.expiresAt, 0, "the account switched to keeps its token");
  // A token a later renewal already replaced is left alone.
  assert.equal(h.account.expireAccess(other!.id, "a-token-already-replaced"), true);
  assert.notEqual(h.store.read().profiles.find((p) => p.id === other!.id)!.tokens!.expiresAt, 0);
});
