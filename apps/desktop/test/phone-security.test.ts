import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PhoneServer } from "../src/main/phone/server.ts";
import { phoneTls } from "../src/main/phone/tls.ts";

const snapshot = { title: "Synthetic draft", revision: "r1", cues: [{ id: "c", paragraphId: "p", speaker: "Mara", heading: "Kitchen", text: "Close the door." }] };
const message = { id: "message-00000001", kind: "note", text: "Check the prop.", cueId: "c", revision: "r1" };
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const post = (url: URL, body: unknown) => fetch(`${url.origin}/api/inbox`, { method: "POST", headers: { authorization: `Bearer ${url.hash.slice(1)}`, "content-type": "application/json" }, body: JSON.stringify(body) });

test("concurrent phone retries wait for the same durable write and never acknowledge a failed save", async () => {
  for (const succeeds of [true, false]) {
    const write = deferred(); let calls = 0, done = 0;
    const server = new PhoneServer(snapshot, () => {}, async () => { calls++; await write.promise; });
    const u = new URL((await server.start("127.0.0.1")).url);
    try {
      const first = post(u, message).then((r) => { done++; return r; });
      const second = post(u, message).then((r) => { done++; return r; });
      for (let i = 0; i < 50 && calls === 0; i++) await delay(2);
      await delay(30);
      assert.equal(calls, 1); assert.equal(done, 0); assert.equal(server.items().length, 0);
      if (succeeds) write.resolve(); else write.reject(new Error("Disk full"));
      const results = await Promise.all([first, second]);
      assert.deepEqual(results.map((r) => r.status), [succeeds ? 200 : 503, succeeds ? 200 : 503]);
      assert.equal(server.items().length, succeeds ? 1 : 0);
    } finally { write.resolve(); await server.stop(); }
  }
});

test("receipt identity cannot be reused for changed text or reinserted after desktop acknowledgement", async () => {
  let writes = 0;
  const server = new PhoneServer(snapshot, () => {}, () => { writes++; });
  const u = new URL((await server.start("127.0.0.1")).url);
  try {
    assert.equal((await post(u, message)).status, 200);
    server.acknowledge(message.id);
    assert.equal((await post(u, message)).status, 200);
    assert.equal(writes, 1); assert.equal(server.items().length, 0);
    assert.equal((await post(u, { ...message, text: "Different content" })).status, 409);
  } finally { await server.stop(); }
});

test("temporary pairing expires and revokes its listener", async () => {
  const server = new PhoneServer(snapshot); let closed = false;
  const info = await server.start("127.0.0.1", undefined, () => { closed = true; }, 40);
  await delay(80);
  assert.equal(closed, true);
  await assert.rejects(fetch(new URL(info.url).origin + "/"));
  await server.stop();
});

test("HTTPS validates IP, expiry and matching private key and serves through a verified TLS connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "inklot-tls-test-"));
  let server: PhoneServer | undefined;
  try {
    const keyPath = join(root, "test.key"), certPath = join(root, "test.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certPath,
      "-subj", "/CN=Inklot automated test", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:FALSE"], { stdio: "ignore" });
    const cert = await readFile(certPath, "utf8"), key = await readFile(keyPath, "utf8");
    const tls = phoneTls(cert, key, "127.0.0.1");
    assert.match(tls.info.fingerprint, /^[A-F0-9:]{95}$/);
    assert.throws(() => phoneTls(cert, key, "192.168.1.2"), /IP address/);
    assert.throws(() => phoneTls(cert, key, "127.0.0.1", Date.now() + 7 * 86400_000), /not currently valid/);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    assert.throws(() => phoneTls(cert, other, "127.0.0.1"), /does not match/);
    server = new PhoneServer(snapshot);
    const info = await server.start("127.0.0.1", tls), u = new URL(info.url);
    const { parseInvite, roomUrl } = await import("@screenplay/relay/protocol");
    const { WebSocket } = await import("ws");
    const invite = parseInvite(JSON.parse(info.pairing).invite);
    assert.equal(invite.relay, u.origin.replace("https:", "wss:"));
    const reader = new WebSocket(roomUrl(invite.relay, invite.room, invite.key), { ca: cert });
    await new Promise<void>((resolve, reject) => { reader.once("message", () => resolve()); reader.once("error", reject); });
    reader.close();
    assert.equal(info.encrypted, true); assert.equal(u.protocol, "https:");
    const get = (origin: string) => new Promise<{ code: number; body: string }>((resolve, reject) => {
      const req = httpsRequest(u.origin + "/api/snapshot", { ca: cert, headers: { authorization: `Bearer ${u.hash.slice(1)}`, origin } }, (res) => {
        let body = ""; res.setEncoding("utf8"); res.on("data", (part) => { body += part; }); res.on("end", () => resolve({ code: res.statusCode!, body }));
      }); req.on("error", reject); req.end();
    });
    assert.equal((await get(u.origin)).code, 200);
    assert.equal((await get(u.origin.replace("https:", "http:"))).code, 403);
  } finally { await server?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("pairing QR grants only a same-origin reader and revokes its room on Stop", async () => {
  const { parseInvite } = await import("@screenplay/relay/protocol");
  const { RelayClient } = await import("@screenplay/relay/client");
  const { ScreenplayDoc } = await import("@screenplay/engine");
  const { publishToPhone } = await import("../src/renderer/features/phone/publisher.ts");
  const server = new PhoneServer(snapshot);
  const info = await server.start("127.0.0.1");
  const qr = JSON.parse(info.pairing);
  const url = new URL(qr.url);
  const invite = parseInvite(qr.invite);
  assert.equal(invite.relay, url.origin.replace("http", "ws"));
  assert.equal(invite.readOnly, true);
  assert.ok(!info.pairing.includes(info.publisher.key));
  const host = new ScreenplayDoc(), reader = new ScreenplayDoc();
  host.insertParagraph(0, { type: "action", runs: [{ text: "Before." }] });
  const publisher = publishToPhone(info.publisher, host, () => ({
    title: "Synthetic", name: "Writer", cursor: null, writers: ["Co-writer"],
  }));
  const client = new RelayClient({ ...invite, doc: reader.ydoc });
  try {
    await client.whenSynced();
    for (let i = 0; i < 80 && !reader.paragraphs().length; i++) await delay(5);
    assert.equal(reader.paragraphs()[0]?.runs[0]?.text, "Before.");
    const end = new Promise<void>(resolve => client.onStatus(s => { if (s === "ended") resolve(); }));
    await server.stop();
    await end;
  } finally { client.destroy(); publisher.stop(); host.ydoc.destroy(); reader.ydoc.destroy(); }
});

test("live anchors and review outcomes require the pairing token and bounded content", async () => {
  const server = new PhoneServer(snapshot);
  const info = await server.start("127.0.0.1"), u = new URL(info.url);
  const item = { id: message.id, kind: "note", text: "Prop", paragraphId: "p", sourceText: "Door" };
  try {
    assert.equal((await fetch(u.origin + "/api/receipts")).status, 401);
    assert.equal((await post(u, { ...item, kind: "draft", paragraphId: "" })).status, 400);
    assert.equal((await post(u, { ...item, kind: "draft", paragraphId: " " })).status, 400);
    // A note written without choosing a passage is accepted unattached.
    assert.equal((await post(u, { ...item, id: message.id + "-loose", paragraphId: "", sourceText: "" })).status, 200);
    assert.equal((await post(u, { ...item, sourceText: "s".repeat(1501) })).status, 400);
    assert.equal((await post(u, { ...item, kind: "bookmark" })).status, 400);
    assert.equal((await post(u, item)).status, 200);
    const ws = new WebSocket(u.origin.replace(/^http/, "ws") +
      "/" + info.publisher.room + "?key=" + info.publisher.key);
    const code = await new Promise<number>(resolve => { ws.onclose = event => resolve(event.code); });
    assert.equal(code, 4401, "The LAN socket must refuse even the publisher key.");
  } finally { await server.stop(); }
});
