import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ScreenplayDoc, plainText } from "@screenplay/engine";
import { PhoneDevices } from "../src/main/phone/devices.ts";
import { PhoneHost } from "../src/main/phone/host.ts";
import { PhoneServer } from "../src/main/phone/server.ts";
import { PhoneInboxStore } from "../src/main/phone/inbox.ts";
import { publishToPhone } from "../src/renderer/features/phone/publisher.ts";
import { decodePairing } from "../../mobile/src/pairing.ts";
import { connect } from "../../mobile/src/live.ts";
import { deliver, syncReceipts, type Take } from "../../mobile/src/outbox.ts";

async function until(ok: () => boolean) {
  for (let i = 0; i < 300 && !ok(); i++) await delay(10);
  assert.ok(ok());
}
const snapshot = { title: "Ferry", revision: "v1", cues: [] };
test("remembered rooms share a stable port, follow their script after restart and revoke immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-remembered-"));
  let host = new PhoneHost();
  const devices = new PhoneDevices(join(root, "devices.json")); await devices.load();
  const inbox = new PhoneInboxStore(join(root, "inbox"));
  const first = await devices.create("a".repeat(64), "127.0.0.1", undefined, false);
  const second = await devices.create("b".repeat(64), "127.0.0.1", undefined, false);
  const doc = new ScreenplayDoc(); doc.insertParagraph(0, { type: "action", runs: [{ text: "Original script." }] });
  const reopenedDoc = new ScreenplayDoc();
  const otherDoc = new ScreenplayDoc(); otherDoc.insertParagraph(0, { type: "action", runs: [{ text: "Other window." }] });
  let activityFailure = false;
  let server: PhoneServer | undefined, other: PhoneServer | undefined;
  let publisher: ReturnType<typeof publishToPhone> | undefined, otherPublisher: typeof publisher;
  let leave: (() => void) | undefined;
  try {
    await host.start("127.0.0.1", "127.0.0.1", 0);
    const port = Number(new URL(host.origin).port);
    const attach = (entry: typeof first, token?: string) => {
      const server = new PhoneServer(snapshot, () => {}, async item => {
        await devices.receive(entry.device.id, entry.device.scriptId, item, inbox);
      });
      const info = server.attach(host, entry.device, token, async name => {
        if (activityFailure) throw new Error("Disk full");
        await devices.seen(entry.device.id, name);
      },
        () => devices.decisions(entry.device.id));
      return { server, info };
    };
    const initial = attach(first, first.token); server = initial.server;
    const pair = decodePairing(initial.info.pairing);
    assert.equal(pair.expiresAt, Number.MAX_SAFE_INTEGER);
    publisher = publishToPhone(initial.info.publisher, doc, () => ({ title: "Ferry", name: "Jo", writers: [], cursor: null }));
    const otherInitial = attach(second, second.token); other = otherInitial.server;
    otherPublisher = publishToPhone(otherInitial.info.publisher, otherDoc, () => ({ title: "Other", name: "Jo", writers: [], cursor: null }));
    assert.equal(new URL(otherInitial.info.url).port, String(port));
    assert.notEqual(otherInitial.info.publisher.room, initial.info.publisher.room);
    let text = "", status = "";
    leave = connect(pair, rows => { text = rows.map(r => r.text).join(" "); }, () => {}, value => { status = value; });
    await until(() => text === "Original script.");
    assert.ok(!text.includes("Other window"));
    const take: Take = { id: "receipt-123456789", room: pair.invite.room, kind: "note", text: "From the road.",
      paragraphId: doc.paragraphs()[0]!.id, sourceText: "Original script.", scene: "", created: Date.now(), outcome: "pending" };
    activityFailure = true;
    await assert.rejects(deliver(pair, take, new AbortController().signal),
      (e: unknown) => e instanceof Error && "status" in e && e.status === 503);
    activityFailure = false;
    await deliver(pair, take, new AbortController().signal);
    assert.equal((await inbox.list(first.device.scriptId)).length, 1);
    assert.equal((await inbox.list(second.device.scriptId)).length, 0);
    publisher.stop(); await server.stop();
    await until(() => status.includes("not open") || status === "Reconnecting");
    await other.stop(); otherPublisher.stop(); await host.stop();
    host = new PhoneHost(); await host.start("127.0.0.1", "127.0.0.1", port);
    const restored = new PhoneDevices(devices.path); await restored.load();
    assert.equal(restored.device(first.device.id)?.writerKey, first.device.writerKey);
    const resumed = attach(first); server = resumed.server;
    assert.equal(resumed.info.publisher.room, pair.invite.room);
    assert.equal(resumed.info.pairing, "", "The server cannot reconstruct the hashed bearer token.");
    doc.insertText(doc.paragraphs()[0]!.id, 0, "Resumed. ");
    reopenedDoc.insertParagraph(0, { type: "action", runs: [{ text: "Resumed. Original script." }] });
    publisher = publishToPhone(resumed.info.publisher, reopenedDoc, () => ({ title: "Ferry", name: "Jo", writers: [], cursor: null }));
    await until(() => text === "Resumed. Original script.");
    await devices.decide(first.device.scriptId, take.id, "accepted", first.device.id);
    await inbox.remove(first.device.scriptId, take.id, first.device.id);
    await deliver(pair, take, new AbortController().signal);
    assert.equal((await inbox.list(first.device.scriptId)).length, 0);
    assert.equal((await syncReceipts(pair, new AbortController().signal, [take])).get(take.id), "accepted");
    assert.equal(plainText(doc.paragraphs()[0]!.runs), "Resumed. Original script.");
    await devices.revoke(first.device.id); await server.stop(true);
    await until(() => status === "Refused");
    await assert.rejects(deliver(pair, take, new AbortController().signal), /revoked/);
  } finally {
    leave?.(); publisher?.stop(); otherPublisher?.stop(); await server?.stop(); await other?.stop();
    await host.stop(); doc.ydoc.destroy(); reopenedDoc.ydoc.destroy(); otherDoc.ydoc.destroy(); await rm(root, { recursive: true, force: true });
  }
});
