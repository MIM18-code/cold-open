import assert from "node:assert/strict";
import test from "node:test";
import { formatInvite, parseInvite } from "@screenplay/relay/protocol";
import { decodePairing } from "../src/pairing.ts";
import { contentHash } from "../src/signing.ts";
import { outcomes, syncReceipts, deliver, type Take } from "../src/outbox.ts";
import { readPresence } from "../src/live.ts";

const now = Date.now();
const payload = {
  v: 1, url: "https://192.168.0.1:444/#" + "t".repeat(43), expiresAt: now + 3600000,
  invite: formatInvite({ relay: "wss://192.168.0.1:444", room: "r".repeat(22), key: "k".repeat(22), readOnly: true }),
};
const pair = decodePairing(JSON.stringify(payload), now);
test("QR parser accepts same-Mac HTTPS and rejects mixed endpoints, public hosts, and write invites", () => {
  assert.equal(pair.secure, true);
  for (const changes of [{ url: payload.url.replace("192.168.0.1", "8.8.8.8") },
    { url: payload.url.replace("444", "999") }, { url: payload.url.replace("https", "http") },
    { invite: formatInvite({ ...parseInvite(payload.invite), readOnly: false }) },
    { url: payload.url.slice(0, -1) }, { expiresAt: now }, { expiresAt: now + 12 * 3600000 }, { v: 2 }]) {
    assert.throws(() => decodePairing(JSON.stringify({ ...payload, ...changes }), now));
  }
  assert.equal(decodePairing(JSON.stringify(payload), now + 7200000, true).expiresAt, payload.expiresAt);
});

test("only valid reviewed receipts and the host's cursor are parsed", () => {
  assert.deepEqual([...outcomes({ "item-123456789": "accepted", invalid: "accepted",
    "item-987654321": "delivered" })], [["item-123456789", { outcome: "accepted", contentHash: undefined }]]);
  assert.throws(() => outcomes([]));
  assert.deepEqual(readPresence([{ user: { name: "Guest" }, cursor: { head: { paragraphId: "guest" } } },
    { doc: { name: "Ferry" }, user: { name: "Host" }, writers: ["A", 42], cursor: { head: { paragraphId: "p" } } }]),
  { title: "Ferry", writers: ["Host", "A"], cursor: "p", offset: 0 });
});

test("retry after a lost reply keeps the exact ID and anchor; a mismatched receipt is never delivered", async t => {
  const item: Take = { id: "test-receipt-123", room: pair.invite.room, kind: "note", text: "Prop.",
    paragraphId: "p", sourceText: "The door.", scene: "Scene 1", created: now, outcome: "pending" };
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_: string, options: RequestInit) => {
    bodies.push(JSON.parse(options.body as string));
    if (bodies.length === 1) throw new TypeError("Offline");
    return Response.json({ id: bodies.length === 2 ? "other" : item.id });
  });
  const signal = new AbortController().signal;
  await assert.rejects(deliver(pair, item, signal), /Offline/);
  await assert.rejects(deliver(pair, item, signal), /different receipt/);
  await deliver(pair, item, signal);
  assert.deepEqual(bodies[0], bodies[2]);
  await assert.rejects(deliver(pair, { ...item, room: "other" }, signal), /different pairing/);
  assert.equal(bodies.length, 3);
});

test("a pairing code that picked up iOS smart quotes still decodes", async () => {
  const { decodePairing } = await import("../src/pairing.ts");
  const now = Date.now();
  const code = JSON.stringify({ v: 1, url: "http://192.168.1.20:52144/#" + "a".repeat(43),
    invite: "screenplay://join?host=192.168.1.20%3A52144&room=um8OOAbFcZTZZl0HN4-NhQ&key=Lz-2iJbSc7fNjCH9HS4Akw&access=read",
    expiresAt: now + 60_000 });
  const curly = code.replace(/"([^"]*)"/g, "“$1”");
  assert.equal(decodePairing(curly, now).origin, "http://192.168.1.20:52144");
});

for (const outcome of ["accepted", "ignored"] as const) {
  test(`receipt sync applies ${outcome} only to matching queued content`, async t => {
    const item: Take = { id: "receipt-123456789", room: pair.invite.room, kind: "note", text: "Real take. 🎬",
      paragraphId: "p", sourceText: "Original quote.", scene: "Scene 1", created: now, outcome: "saved" };
    const signal = new AbortController().signal;
    const hash = await contentHash(item);
    let decision: unknown = { outcome, contentHash: hash };
    t.mock.method(globalThis, "fetch", async () => Response.json({ [item.id]: decision }));
    assert.equal((await syncReceipts(pair, signal, [item])).get(item.id), outcome);
    for (const change of [{ kind: "draft" as const }, { text: "Forged take." },
      { paragraphId: "another-p" }, { sourceText: "Forged quote." }]) {
      decision = { outcome, contentHash: await contentHash({ ...item, ...change }) };
      assert.equal((await syncReceipts(pair, signal, [item])).get(item.id), "conflict");
    }
    for (const invalid of [outcome, { outcome }, { outcome, contentHash: null },
      { outcome, contentHash: "bad" }]) {
      decision = invalid;
      assert.equal((await syncReceipts(pair, signal, [item])).get(item.id), "conflict");
    }
    decision = { outcome, contentHash: hash };
    assert.deepEqual([...await syncReceipts(pair, signal, [{ ...item, room: "different-room" }])], []);
    assert.deepEqual([...await syncReceipts(pair, signal, [])], []);
  });
}
