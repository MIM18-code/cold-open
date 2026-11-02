import assert from "node:assert/strict";
import test from "node:test";
import { PhoneServer, validateSnapshot } from "../src/main/phone/server.ts";
import { FORMATTER_MODEL, OllamaModels, localModels } from "../src/main/models/ollama.ts";
const digest = "a".repeat(64);
const installed = { models: [{ name: FORMATTER_MODEL, digest, size: 3000000000 }] };
test("model lists refuse incomplete/cloud entries, and malformed version digests cannot be pinned", async () => {
    assert.equal(localModels({ models: [...installed.models, { name: "x-cloud", digest, size: 12 }, { name: "fake", digest: "unknown", size: 12 }] }).length, 1);
    const m = new OllamaModels(async () => { throw new Error("must not request"); });
    await assert.rejects(() => m.pin("../../secret"), /Invalid model digest/);
});
test("a streamed download is not ready until success and a valid installed model are both present", async () => {
    const requests: {
        url: string;
        body: any;
    }[] = [];
    const m = new OllamaModels((async (url, init) => { requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }); return String(url).endsWith("/api/tags") ? Response.json(installed) : new Response('{"status":"pulling","total":100,"completed":80}\n{"status":"verifying sha256 digest"}\n{"status":"success"}\n'); }) as typeof fetch);
    const progress: any[] = [];
    assert.equal((await m.pull(new AbortController().signal, (p) => progress.push(p))).digest, digest);
    assert.equal(progress.at(-1).state, "ready");
    assert(requests.every((r) => r.url.startsWith("http://127.0.0.1:11434/")));
    assert.equal(requests[0]!.body.insecure, false);
    const incomplete = new OllamaModels((async () => new Response('{"status":"pulling","completed":80}\n')) as typeof fetch);
    await assert.rejects(() => incomplete.pull(new AbortController().signal, () => { }), /without a verified completion/);
});
test("pinning verifies the copied digest and removal is limited to an installed app-owned alias", async () => {
    let copied = false, deleted = false;
    const name = `inklot-format:sha-${digest.slice(0, 24)}`;
    const m = new OllamaModels((async (url, init) => { const path = String(url).split("11434")[1]; if (path === "/api/copy") {
        copied = true;
        return Response.json({ status: "success" });
    } if (path === "/api/delete") {
        deleted = true;
        return new Response(null, { status: 200 });
    } return Response.json({ models: [...installed.models, ...(copied ? [{ name, digest, size: 3000 }] : [])] }); }) as typeof fetch);
    const pin = await m.pin(digest);
    assert.equal(pin.name, name);
    await assert.rejects(() => m.remove(FORMATTER_MODEL, digest), /Only a Cold Open/);
    assert.equal(deleted, false);
    await m.remove(name, digest);
    assert.equal(deleted, true);
});
test("phone pairing requires the token, rejects other origins, queues reviewed text, and revokes on stop", async () => {
    const source = { title: "Draft", revision: "session:1", cues: [{ id: "c1", paragraphId: "p1", speaker: "MARA", heading: "INT. ROOM", text: "Open the door." }] };
    const commands: string[] = [];
    const server = new PhoneServer(source, (c) => commands.push(c));
    const { url } = await server.start("127.0.0.1");
    const parsed = new URL(url), token = parsed.hash.slice(1), base = parsed.origin, headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    try {
        const page = await fetch(base);
        assert.equal(page.status, 200);
        const html = await page.text();
        assert(!html.includes(source.cues[0]!.text));
        assert(!html.includes(token));
        assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
        assert.equal((await fetch(base + "/api/snapshot")).status, 401);
        assert.equal((await fetch(base + "/api/snapshot", { headers: { ...headers, origin: "http://attacker.invalid" } })).status, 403);
        const snapshot = await (await fetch(base + "/api/snapshot", { headers })).json();
        assert.equal(snapshot.cues[0].text, "Open the door.");
        const body = { id: "client-item-0001", kind: "note", text: "Hold on the door.", cueId: "c1", revision: "session:1" };
        assert.equal((await fetch(base + "/api/inbox", { method: "POST", headers, body: JSON.stringify(body) })).status, 200);
        await fetch(base + "/api/inbox", { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(server.items().length, 1);
        assert.equal(server.items()[0]?.paragraphId, "p1");
        assert.equal((await fetch(base + "/api/command", { method: "POST", headers, body: JSON.stringify({ revision: "session:1", command: "delete-file" }) })).status, 400);
        await fetch(base + "/api/command", { method: "POST", headers, body: JSON.stringify({ revision: "session:1", command: "pause" }) });
        assert.deepEqual(commands, ["pause"]);
        server.publish({ ...source, revision: "session:2" });
        assert.equal((await fetch(base + "/api/inbox", { method: "POST", headers, body: JSON.stringify({ ...body, id: "client-item-0002" }) })).status, 409);
        assert.equal(server.items().length, 1);
        server.acknowledge(body.id);
        assert.equal(server.items().length, 0);
    }
    finally {
        await server.stop();
    }
    await assert.rejects(() => fetch(base + "/api/snapshot", { headers }));
});
test("phone snapshots reject duplicate passages, oversized text and malformed data before starting a server", () => {
    const cue = { id: "c", paragraphId: "p", speaker: "M", heading: "H", text: "T" };
    assert.throws(() => validateSnapshot({ title: "T", revision: "r", cues: [cue, cue] }), /Invalid phone/);
    assert.throws(() => validateSnapshot({ title: "T", revision: "r", cues: [{ ...cue, text: "x".repeat(1501) }] }), /Invalid phone/);
    assert.throws(() => validateSnapshot(null), /invalid/);
});
