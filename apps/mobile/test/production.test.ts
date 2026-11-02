import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneServer } from "../../desktop/src/main/phone/server.ts";
import { PhoneDevices } from "../../desktop/src/main/phone/devices.ts";
import { validateFolderItem, PhoneFolder } from "../../desktop/src/main/phone/folder.ts";
import { PhoneInboxStore } from "../../desktop/src/main/phone/inbox.ts";
import { decodePairing } from "../src/pairing.ts";
import { deliver, folderItem, inboxBody, syncReceipts, type Take } from "../src/outbox.ts";
import { folderProduction } from "../src/production.ts";
import { signTake, contentHash } from "../src/signing.ts";

const snapshot = { title: "Script", revision: "r1", cues: [] };
const production = { v: 2 as const, active: null, sets: [], scenes: [], marks: {}, lockedPages: [] };
const take = (room: string): Take => ({ id: "scene-message-00001", room, kind: "scene-after", text: "INT. BOAT - NIGHT",
  paragraphId: "scene-heading-1", sourceText: "INT. ROOM - DAY", scene: "1", created: 1, outcome: "pending" });

test("live scene suggestions require HMAC, bind destination and preserve receipt decisions", async t => {
  const server = new PhoneServer(snapshot);
  try {
    let info;
    try { info = await server.start("127.0.0.1"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EPERM") { t.skip("Sandbox forbids listening on localhost"); return; } throw e; }
    const pair = decodePairing(info.pairing);
    const item = take(pair.invite.room), signal = new AbortController().signal;
    const unsigned = await fetch(pair.origin + "/api/inbox", { method: "POST",
      headers: { Authorization: "Bearer " + pair.token, "Content-Type": "application/json" }, body: JSON.stringify(inboxBody(item)) });
    assert.equal(unsigned.status, 403);
    await deliver(pair, item, signal);
    assert.equal(server.items()[0].kind, "scene-after");
    server.acknowledge(item.id, "accepted");
    assert.equal((await syncReceipts(pair, signal, [item])).get(item.id), "accepted");
    assert.equal((await syncReceipts(pair, signal, [{ ...item, kind: "scene-end" }])).get(item.id), "conflict");
    assert.notEqual(await contentHash(item), await contentHash({ ...item, kind: "scene-end" }));
    await deliver(pair, item, signal);
    assert.equal(server.items().length, 0);
  } finally { await server.stop(); }
});

test("offline scene suggestions preserve signatures and production snapshots are scoped to their script", async () => {
  const path = await mkdtemp(join(tmpdir(), "phone-production-"));
  try {
    const devices = new PhoneDevices(join(path, "devices.json"));
    await devices.load();
    const scriptId = "a".repeat(64);
    const { device, token } = await devices.create(scriptId, "127.0.0.1", undefined, false);
    const pair = { ...decodePairing(JSON.stringify({ v: 1, url: "http://127.0.0.1:4455/#" + "t".repeat(43), expiresAt: Date.now() + 3600000,
      invite: "screenplay://join?relay=ws%3A%2F%2F127.0.0.1%3A4455&room=" + "r".repeat(22) + "&key=" + "k".repeat(22) + "&access=read" })), remembered: true, deviceId: device.id, scriptId, token };
    const item = take(pair.invite.room), raw = await folderItem(pair, item);
    const signed = JSON.parse(raw);
    assert.equal(validateFolderItem(signed, device.id, scriptId, devices.verifyTake.bind(devices)).kind, "scene-after");
    assert.throws(() => validateFolderItem({ ...signed, kind: "scene-end" }, device.id, scriptId, devices.verifyTake.bind(devices)), /signature/);
    assert.throws(() => validateFolderItem({ ...signed, paragraphId: "different-scene" }, device.id, scriptId, devices.verifyTake.bind(devices)), /signature/);
    const store = new PhoneInboxStore(join(path, "inbox"));
    const folder = new PhoneFolder(path, devices, store, () => {}, () => {});
    await folder.publish(scriptId, { ...snapshot, production, paragraphs: [] });
    const published = await readFile(join(path, "Inklot Phone Inbox", device.id, "production.json"), "utf8");
    assert.deepEqual(folderProduction(published, scriptId).production, production);
    assert.throws(() => folderProduction(published, "b".repeat(64)), /Invalid/);
    assert.throws(() => folderProduction(JSON.stringify({ v: 1 }), scriptId), /Invalid/);
    await folder.stop();
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("HTTP scene envelopes use v2 and sign both destinations with the existing HMAC fields", async t => {
  const pair = decodePairing(JSON.stringify({ v: 1, url: "http://127.0.0.1:4455/#" + "t".repeat(43), expiresAt: Date.now() + 3600000,
    invite: "screenplay://join?relay=ws%3A%2F%2F127.0.0.1%3A4455&room=" + "r".repeat(22) + "&key=" + "k".repeat(22) + "&access=read" }));
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    body = JSON.parse(String(options.body));
    return new Response(JSON.stringify({ id: body.id }), { status: 200 });
  });
  for (const kind of ["scene-after", "scene-end"] as const) {
    const item = { ...take(pair.invite.room), kind };
    await deliver(pair, item, new AbortController().signal);
    assert.equal(body.v, 2);
    assert.equal(body.kind, kind);
    assert.equal(body.sig, await signTake(pair.token, "", "", item));
  }
  assert.throws(() => folderProduction(JSON.stringify({ v: 2, scriptId: "x", title: "X", paragraphs: [],
    production: { ...production, scenes: [{ id: "p", changes: null }] } }), "x"), /Invalid/);
});

test("folder publication bounds the final UTF-8 envelope and keeps the last readable snapshot", async () => {
  const path = await mkdtemp(join(tmpdir(), "phone-production-size-"));
  const scriptId = "a".repeat(64);
  const devices = new PhoneDevices(join(path, "devices.json"));
  await devices.load();
  const { device } = await devices.create(scriptId, "127.0.0.1", undefined, false);
  const folder = new PhoneFolder(path, devices, new PhoneInboxStore(join(path, "inbox")), () => {}, () => {});
  try {
    const initial = { ...snapshot, production, paragraphs: [] };
    await folder.publish(scriptId, initial);
    const file = join(path, "Inklot Phone Inbox", device.id, "production.json");
    const before = await readFile(file, "utf8");
    const large = { ...initial, paragraphs: [{ id: "p", type: "action" as const, runs: [{ text: "字".repeat(700000) }] }] };
    await assert.rejects(folder.publish(scriptId, large), /2,000,000 bytes/);
    assert.equal(await readFile(file, "utf8"), before);
    assert.throws(() => folderProduction(JSON.stringify({ v: 2, scriptId, ...large }), scriptId), /too large/);
    // ASCII can fit as a snapshot but exceed the cap once the folder envelope is included.
    const overhead = Buffer.byteLength(JSON.stringify({ v: 2, scriptId, ...large, paragraphs: [{ id: "p", type: "action", runs: [{ text: "" }] }] }));
    const boundary = { ...large, paragraphs: [{ id: "p", type: "action" as const, runs: [{ text: "x".repeat(2000000 - overhead) }] }] };
    await folder.publish(scriptId, boundary);
    const exact = await readFile(file, "utf8");
    assert.equal(Buffer.byteLength(exact), 2000000);
    assert.equal(folderProduction(exact, scriptId).paragraphs.length, 1);
    boundary.paragraphs[0]!.runs[0]!.text += "x";
    await assert.rejects(folder.publish(scriptId, boundary), /2,000,000 bytes/);
    assert.equal(await readFile(file, "utf8"), exact);
  } finally { await folder.stop(); await rm(path, { recursive: true, force: true }); }
});
