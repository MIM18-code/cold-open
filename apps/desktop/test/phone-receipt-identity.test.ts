import { signEnvelope } from "./phone-signing.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PhoneDevices } from "../src/main/phone/devices.ts";
import { PhoneInboxStore } from "../src/main/phone/inbox.ts";
import { PhoneServer } from "../src/main/phone/server.ts";
import type { PhoneHost } from "../src/main/phone/host.ts";
import { validateFolderItem } from "../src/main/phone/folder.ts";
import { importTakesFile } from "../src/main/phone/takes.ts";
import { phoneReceiptKey } from "../src/shared/channels/phone.ts";
import { acceptPhoneRecord } from "../src/renderer/features/phone/receipts.ts";
import { DocumentSession } from "../src/renderer/core/session.ts";
import { createRecord, records } from "../src/renderer/features/rewrite/records.ts";

const scriptId = "a".repeat(64);
const item = { id: "receipt-000000001", kind: "note" as const, text: "First phone.", paragraphId: "p",
  sourceText: "Captured.", cueId: "", revision: "r1", created: new Date().toISOString() };

for (const route of ["live", "folder", "AirDrop"] as const) {
  test(`${route} keeps colliding receipt IDs separate through delivery, acceptance and status`, async () => {
    const root = await mkdtemp(join(tmpdir(), "receipt-identity-"));
    const devices = new PhoneDevices(join(root, "devices.json"));
    const store = new PhoneInboxStore(join(root, "inbox"));
    const first = await devices.create(scriptId, "127.0.0.1");
    const second = await devices.create(scriptId, "127.0.0.1");
    const session = DocumentSession.untitled();
    const servers: PhoneServer[] = [];
    const host = { origin: "http://localhost:4456", routes: new Map(), relay: {
      port: 4456, createRoom: () => ({ room: "room", key: "key", readKey: "read" }), closeRoom() {},
    } } as unknown as PhoneHost;
    const deliver = async (pair: typeof first, text: string) => {
      const envelope = signEnvelope({ ...item, text, v: 1, deviceId: pair.device.id, scriptId }, pair.device.tokenHash);
      if (route === "folder") {
        const inbox = validateFolderItem(envelope, pair.device.id, scriptId, devices.verifyTake.bind(devices));
        await devices.receive(pair.device.id, scriptId, inbox, store);
      } else if (route === "AirDrop") {
        const path = join(root, "takes.coldopentakes");
        await writeFile(path, JSON.stringify({ ...envelope, takes: [envelope] }));
        await importTakesFile(path, devices, store, () => ({ title: "Draft" }));
      } else {
        const server = new PhoneServer({ title: "Draft", revision: "r1", cues: [] }, () => {},
          value => devices.receive(pair.device.id, scriptId, value, store).then(() => {}));
        servers.push(server);
        server.attach(host, pair.device, pair.token, async () => {}, () => devices.decisions(pair.device.id));
        const req = Object.assign(Readable.from([JSON.stringify(envelope)]), {
          headers: { host: "localhost:4456", authorization: `Bearer ${pair.token}`, "content-type": "application/json" },
          method: "POST", url: "/api/inbox", socket: { remoteAddress: "127.0.0.1" },
        });
        let code = 0, reply = "";
        await server["route"](req as never, { writeHead(n: number) { code = n; },
          end(body: string) { reply = body; } } as never, "", "");
        if (code !== 200) throw new Error(reply);
        assert.equal(server["deviceId"], pair.device.id);
      }
    };
    try {
      await deliver(first, item.text);
      await deliver(second, "Second phone.");
      await deliver(first, item.text);
      await assert.rejects(deliver(second, "Changed text."), /already used/);
      const rows = await store.list(scriptId);
      assert.equal(rows.length, 2);
      assert.notEqual(phoneReceiptKey(rows[0]!), phoneReceiptKey(rows[1]!));
      for (const row of rows) await acceptPhoneRecord(session, phoneReceiptKey(row),
        createRecord("note", "Phone", row.text), () => true);
      assert.equal(records(session.doc).length, 2);
      await devices.decide(scriptId, item.id, "accepted", first.device.id);
      await store.remove(scriptId, item.id, first.device.id);
      assert.equal(devices.decisions(first.device.id)[item.id]?.outcome, "accepted");
      assert.deepEqual(devices.decisions(second.device.id), {});
      assert.deepEqual((await store.list(scriptId)).map(row => row.text), ["Second phone."]);
      await deliver(first, item.text);
      assert.equal((await store.list(scriptId)).length, 1);
      const moved = "b".repeat(64);
      await store.append(moved, { ...item, deviceId: first.device.id });
      await store.move(scriptId, moved);
      assert.equal((await store.list(moved)).length, 2);
    } finally {
      session.destroy();
      await Promise.all(servers.map(s => s.stop()));
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("legacy inbox rows gain a device only when the ledger identifies their content uniquely", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-legacy-"));
  const devices = new PhoneDevices(join(root, "devices.json"));
  const store = new PhoneInboxStore(join(root, "inbox"));
  try {
    const first = await devices.create(scriptId, "127.0.0.1");
    const second = await devices.create(scriptId, "127.0.0.1");
    await devices.receive(first.device.id, scriptId, item, store);
    await writeFile(join(root, "inbox", scriptId + ".json"), JSON.stringify([item]));
    await devices.migrateInbox(store);
    assert.equal((await store.list(scriptId))[0]!.deviceId, first.device.id);
    await devices.receive(second.device.id, scriptId, item, store);
    await writeFile(join(root, "inbox", scriptId + ".json"), JSON.stringify([item]));
    await devices.migrateInbox(store);
    assert.equal((await store.list(scriptId))[0]!.deviceId, undefined);
    await store.append(scriptId, { ...item, deviceId: second.device.id, text: "Other phone." });
    await store.remove(scriptId, item.id);
    assert.deepEqual((await store.list(scriptId)).map(row => row.text), ["Other phone."]);
    await devices.decide(scriptId, item.id, "ignored");
    assert.deepEqual(devices.decisions(first.device.id), {});
    assert.deepEqual(devices.decisions(second.device.id), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
