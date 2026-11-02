import assert from "node:assert/strict";
import test from "node:test";
import { formatInvite } from "@screenplay/relay/protocol";
import { decodePairing } from "../src/pairing.ts";
import { isTailnet, reachStatus } from "../src/reach.ts";
import { takesFile, takesFileName, waitingTakes } from "../src/takes-file.ts";
import type { Take } from "../src/outbox.ts";

const now = Date.now();
function payload(host: string, remembered = true) {
  return { v: 1, url: `https://${host}:4456/#${"t".repeat(43)}`,
    invite: formatInvite({ relay: `wss://${host}:4456`, key: "k".repeat(22),
      room: "r".repeat(22), readOnly: true }),
    ...(remembered ? { remembered: true, deviceId: "device-123456789", scriptId: "a".repeat(64), expiresAt: null }
      : { expiresAt: now + 7200000 }) };
}
const pair = decodePairing(JSON.stringify(payload("mac.tail123.ts.net")));
const lanPair = decodePairing(JSON.stringify(payload("192.168.1.20")));
const oneOff = decodePairing(JSON.stringify(payload("mac.tail123.ts.net", false)));
const take = (id: string, outcome: Take["outcome"], room = pair.invite.room): Take => ({
  id, room, kind: "note", text: "Check this prop.", paragraphId: "p",
  sourceText: "The captured passage.", scene: "Scene 1", created: now, outcome,
});

test("the AirDrop file holds only the waiting takes, with the iCloud fields plus device and script identity", async () => {
  const takes = [take("receipt-000000001", "pending"), take("receipt-000000002", "saved"),
    take("receipt-000000003", "delivered"), take("receipt-000000004", "pending", "another-room")];
  const waiting = waitingTakes(pair, takes);
  assert.deepEqual(waiting.map(item => item.id), ["receipt-000000001", "receipt-000000002"]);
  const file = JSON.parse(await takesFile(pair, waiting));
  assert.equal(file.v, 1);
  assert.equal(file.deviceId, pair.deviceId);
  assert.equal(file.scriptId, pair.scriptId);
  assert.equal(file.takes.length, 2);
  assert.deepEqual(Object.keys(file.takes[0]).sort(),
    ["id", "kind", "paragraphId", "sig", "sourceText", "text"]);
  assert.equal(file.takes[0].id, "receipt-000000001");
  assert.equal(file.takes[0].sourceText, "The captured passage.");
  assert.equal(takesFileName(new Date(2026, 9, 31, 12)), "Cold Open takes 2026-10-31.coldopentakes");
});

test("an AirDrop export needs a remembered pairing, waiting takes and takes within the size limit", async () => {
  await assert.rejects(() => takesFile(oneOff, [take("receipt-000000001", "pending")]), /Remember this iPhone/);
  await assert.rejects(() => takesFile(pair, []), /no waiting takes/);
  await assert.rejects(() => takesFile(pair, [take("receipt-000000001", "pending", "another-room")]),
    /different pairing/);
  await assert.rejects(() => takesFile(pair, [{ ...take("receipt-000000001", "pending"), text: "字".repeat(20000) }]),
    /24,000-byte/);
});

test("an unreachable remembered iPhone explains the likely causes and where waiting takes go", () => {
  const tailnet = reachStatus("unreachable", { tailnet: true, folder: true });
  assert.match(tailnet, /Tailscale may be off on this iPhone/);
  assert.match(tailnet, /asleep/);
  assert.match(tailnet, /Cold Open may be closed/);
  assert.match(tailnet, /Waiting takes will go to iCloud, or send later\./);
  const lan = reachStatus("unreachable", { tailnet: false, folder: true });
  assert.doesNotMatch(lan, /Tailscale/);
  assert.match(lan, /off your Wi-Fi/);
  const closed = reachStatus("script-closed", { tailnet: true, folder: false });
  assert.match(closed, /The script is not open on the Mac/);
  assert.match(closed, /Waiting takes will stay on this iPhone and send later\./);
  assert.equal(isTailnet(pair), true);
  assert.equal(isTailnet(lanPair), false);
});


test("AirDrop sends the oldest 100 and subsequent files reach every remaining take", async () => {
  const { takesBatch, unsentTakes } = await import("../src/takes-file.ts");
  const takes = Array.from({ length: 205 }, (_, i) => ({
    ...take(`receipt-${String(i).padStart(9, "0")}`, i % 2 ? "saved" : "pending"), created: now + i,
  })).reverse();
  const sent: string[] = [];
  for (const count of [100, 100, 5]) {
    const batch = takesBatch(pair, takes);
    const file = JSON.parse(await takesFile(pair, batch));
    assert.equal(file.takes.length, count);
    assert.equal(batch[0]!.created, now + sent.length);
    sent.push(...batch.map(t => t.id));
    for (const item of batch) takes.find(t => t.id === item.id)!.outcome = "airdropped";
    assert.equal(unsentTakes(pair, takes).length, 205 - sent.length);
  }
  assert.equal(new Set(sent).size, 205);
  assert.deepEqual(takesBatch(pair, takes), []);
  assert.equal(waitingTakes(pair, takes).length, 205, "AirDrop still awaits the Mac's receipts.");
});


test("a takes file caps an oversized queue at its oldest 100 takes", async () => {
  const items = Array.from({ length: 101 }, (_, i) => ({
    ...take(`receipt-${String(i).padStart(9, "0")}`, "pending"), created: now + i,
  })).reverse();
  const file = JSON.parse(await takesFile(pair, items));
  assert.equal(file.takes.length, 100);
  assert.equal(file.takes[0].id, "receipt-000000000");
  assert.equal(file.takes[99].id, "receipt-000000099");
  assert.equal(items.length, 101);
});
