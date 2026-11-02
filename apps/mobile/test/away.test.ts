import assert from "node:assert/strict";
import test from "node:test";
import { formatInvite } from "@screenplay/relay/protocol";
import { decodePairing } from "../src/pairing.ts";
import { sendPending, folderItem, validateTakeSize, type Take, type Outcome } from "../src/outbox.ts";
import { readerAnchor } from "../src/reader-anchor.ts";
const now = Date.now();
function payload(host: string, secure = true, remembered = true) {
  return { v: 1, url: `${secure ? "https" : "http"}://${host}:4456/#${"t".repeat(43)}`,
    invite: formatInvite({ relay: `${secure ? "wss" : "ws"}://${host}:4456`, key: "k".repeat(22),
      room: "r".repeat(22), readOnly: true }),
    ...(remembered ? { remembered: true, deviceId: "device-123456789", scriptId: "a".repeat(64), expiresAt: null }
      : { expiresAt: now + 7200000 }) };
}
const pair = decodePairing(JSON.stringify(payload("mac.tail123.ts.net")));
const take: Take = { id: "receipt-123456789", room: pair.invite.room, kind: "note", text: "A note.",
  paragraphId: "p", sourceText: "A quote.", scene: "Scene 1", created: now, outcome: "pending" };

test("only HTTPS Tailscale DNS and CGNAT can pair, and remembered QR codes survive years", () => {
  for (const host of ["mac.tail123.ts.net", "100.64.0.1", "100.127.255.255"]) {
    const raw = JSON.stringify(payload(host));
    assert.ok(decodePairing(raw, now + 10 * 365 * 86400000).remembered);
    assert.throws(() => decodePairing(JSON.stringify(payload(host, false))));
  }
  for (const host of ["100.63.255.255", "100.128.0.0", "mac.ts.net.evil.com", "example.com", "-mac.ts.net"])
    assert.throws(() => decodePairing(JSON.stringify(payload(host))));
  for (const change of [{ scriptId: "bad" }, { deviceId: "../../bad" }, { expiresAt: now + 1 }])
    assert.throws(() => decodePairing(JSON.stringify({ ...payload("mac.ts.net"), ...change })));
  assert.throws(() => decodePairing(JSON.stringify({ ...payload("mac.ts.net"),
    invite: payload("other.ts.net").invite })));
  assert.throws(() => decodePairing(JSON.stringify(payload("192.168.1.2", false, false)), now + 7200001));
});

test("rejected items are terminal and cannot starve later batches; transient capacity failures stay queued", async t => {
  const items = Array.from({ length: 12 }, (_, i) => ({ ...take, id: `receipt-item-${i.toString().padStart(3, "0")}`,
    created: now + i, text: i < 8 ? "bad" : "good" })).reverse();
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    return Response.json(body.text === "bad" ? { error: "Invalid note" } : { id: body.id },
      { status: body.text === "bad" ? 400 : 200 });
  });
  const update = (id: string, state: Outcome, error?: string) => {
    Object.assign(items.find(item => item.id === id)!, { outcome: state, error });
  };
  await sendPending(pair, items, new AbortController().signal, update);
  assert.equal(items.filter(i => i.outcome === "rejected").length, 8);
  assert.ok(items.filter(i => i.outcome === "rejected").every(i => i.error === "Invalid note" && i.text === "bad"));
  await sendPending(pair, items, new AbortController().signal, update);
  assert.equal(items.filter(i => i.outcome === "delivered").length, 4);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Inbox full" }, { status: 409 }));
  const pending = { ...take };
  await assert.rejects(sendPending(pair, [pending], new AbortController().signal, update), /Inbox full/);
  assert.equal(pending.outcome, "pending");
});

test("size limit measures UTF-8 JSON bytes including anchors, escapes and CJK; folder items keep the same receipt", async () => {
  validateTakeSize({ ...take, text: "a".repeat(20000) });
  for (const text of ["字".repeat(20000), "😀".repeat(6000), "\\".repeat(15000)])
    assert.throws(() => validateTakeSize({ ...take, text }), /24,000-byte/);
  const json = JSON.parse(await folderItem(pair, take));
  assert.equal(json.id, take.id); assert.equal(json.deviceId, pair.deviceId); assert.equal(json.scriptId, pair.scriptId);
  assert.equal(json.sourceText, take.sourceText);
  await assert.rejects(() => folderItem(pair, { ...take, room: "another-room" }), /Remember/);
});

test("deleted paragraph resolves to the nearest surviving neighbor, then the visible passage, and requests confirmation", () => {
  const rows = ["a", "c", "d"].map(id => ({ id }));
  assert.deepEqual(readerAnchor(rows, "b", ["a", "b", "c", "d"], "d"), { row: { id: "c" }, changed: true });
  assert.deepEqual(readerAnchor(rows, "d", ["a", "b", "c", "d"], "a"), { row: { id: "d" }, changed: false });
  assert.deepEqual(readerAnchor(rows, "removed", [], "d"), { row: { id: "d" }, changed: true });
  assert.equal(readerAnchor(rows, "removed", [], "missing").row, undefined);
  assert.equal(readerAnchor([], "b", ["a", "b"], "a").row, undefined);
});

test("draft outbox retries the same Fountain text and attachment through live and folder delivery", async t => {
  const draft: Take = { ...take, kind: "draft", text: "INT. KITCHEN - DAY\n\nMARA\n(quietly)\nClose the door." };
  const bodies: unknown[] = [], states: Outcome[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(options.body as string));
    if (bodies.length === 1) throw new TypeError("Offline");
    return Response.json({ id: draft.id });
  });
  const signal = new AbortController().signal;
  await assert.rejects(sendPending(pair, [draft], signal, (_, state) => states.push(state)), /Offline/);
  const folder = JSON.parse(await folderItem(pair, draft));
  await sendPending(pair, [{ ...draft, outcome: "saved" }], signal, (_, state) => states.push(state));
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[0], { id: folder.id, kind: folder.kind, text: folder.text,
    paragraphId: folder.paragraphId, sourceText: folder.sourceText });
  assert.equal(folder.kind, "draft");
  assert.deepEqual(states, ["delivered"]);
  assert.throws(() => validateTakeSize({ ...draft, text: "字".repeat(20000) }), /24,000-byte/);
});
