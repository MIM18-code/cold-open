import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenplayDoc, parseFountain } from "@screenplay/engine";
import { PhoneServer } from "../../desktop/src/main/phone/server.ts";
import { PhoneInboxStore } from "../../desktop/src/main/phone/inbox.ts";
import { publishToPhone } from "../../desktop/src/renderer/features/phone/publisher.ts";
import { decodePairing } from "../src/pairing.ts";
import { connect, type Row, type Presence } from "../src/live.ts";
import { deliver, syncReceipts, type Take } from "../src/outbox.ts";

async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await sleep(10);
  assert.ok(ok());
}
test("live edits and awareness reach the reader; retries survive desktop review without editing the script", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inklot-mobile-"));
  const store = new PhoneInboxStore(dir), key = "test-document-key";
  const server = new PhoneServer({ title: "Ferry", revision: "v1", cues: [] },
    () => {}, item => store.append(key, item));
  const info = await server.start("127.0.0.1"), pair = decodePairing(info.pairing);
  const doc = ScreenplayDoc.fromScript(parseFountain("INT. FERRY - DAY\n\nA rope."));
  const id = doc.paragraphs()[1]!.id, point = { paragraphId: id, offset: 1 };
  const host = publishToPhone(info.publisher, doc, () => ({
    title: "Ferry", name: "Writer", writers: [], cursor: { head: point, anchor: point },
  }));
  let rows: Row[] = [], state = "", presence: Presence | null = null;
  const leave = connect(pair, v => { rows = v; }, v => { presence = v; }, v => { state = v; });
  try {
    await until(() => state === "Live" && rows.length === 2 && presence?.cursor === id);
    doc.insertText(id, 0, "Wet. ");
    await until(() => rows[1]?.text === "Wet. A rope.");
    const signal = new AbortController().signal;
    for (const kind of ["draft", "dictation", "note"] as const) {
      const item: Take = { kind, text: "Keep the rope.", sourceText: rows[1]!.text,
        id: "receipt-1234-" + kind, room: pair.invite.room, paragraphId: id,
        outcome: "pending", scene: "Scene 1", created: Date.now() };
      await deliver(pair, item, signal);
      await deliver(pair, item, signal);
      const saved = await store.list(key);
      assert.equal(saved.length, 1);
      assert.equal(saved[0]!.paragraphId, id);
      // Receipts are per device, so removal names the device that sent the item.
      await store.remove(key, item.id, saved[0]!.deviceId);
      const decision = kind === "dictation" ? "accepted" : "ignored";
      server.acknowledge(item.id, decision);
      await deliver(pair, item, signal);
      assert.deepEqual(await store.list(key), []);
      assert.equal((await syncReceipts(pair, signal, [item])).get(item.id), decision);
      await assert.rejects(deliver(pair, { ...item, text: "Changed" }, signal), /different content/);
    }
    assert.equal(doc.paragraphs().length, 2);
    await server.stop();
    await until(() => state === "Host stopped sharing");
  } finally {
    leave(); host.stop(); doc.ydoc.destroy(); await server.stop(); await rm(dir, { recursive: true });
  }
});
