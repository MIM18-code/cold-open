import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PhoneDevices } from "../src/main/phone/devices.ts";
import { PhoneFolder, validateFolderItem } from "../src/main/phone/folder.ts";
import { PhoneInboxStore } from "../src/main/phone/inbox.ts";
import { importTakesFile } from "../src/main/phone/takes.ts";
import { PhoneServer } from "../src/main/phone/server.ts";
import type { PhoneHost } from "../src/main/phone/host.ts";
import { folderItem, type Take } from "../../mobile/src/outbox.ts";
import { takesFile } from "../../mobile/src/takes-file.ts";
import { decodePairing } from "../../mobile/src/pairing.ts";
import { signEnvelope } from "./phone-signing.ts";

const scriptId = "a".repeat(64);
const take: Take = { id: "receipt-123456789", room: "", kind: "draft", text: "INT. CAFÉ - DAY\n\n字 🎬",
  paragraphId: "p", sourceText: "A passage.", scene: "Scene 1", created: 1, outcome: "pending" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "phone-file-auth-"));
  const devices = new PhoneDevices(join(root, "devices.json"));
  const { device, token } = await devices.create(scriptId, "127.0.0.1");
  const store = new PhoneInboxStore(join(root, "inbox"));
  const server = new PhoneServer({ title: "Draft", revision: "r1", cues: [] }, () => {},
    item => devices.receive(device.id, scriptId, item, store).then(() => {}));
  const host = { origin: "http://127.0.0.1:4456", routes: new Map(), relay: {
    port: 4456, createRoom: () => ({ room: "r".repeat(22), key: "k".repeat(22), readKey: "s".repeat(22) }),
    closeRoom() {},
  } } as unknown as PhoneHost;
  const info = server.attach(host, device, token, async () => {}, () => devices.decisions(device.id));
  const pair = decodePairing(info.pairing), item = { ...take, room: pair.invite.room };
  const sub = join(root, "Inklot Phone Inbox", device.id);
  await mkdir(sub, { recursive: true });
  const errors: string[] = [];
  const folder = new PhoneFolder(root, devices, store, () => {}, e => errors.push(e));
  const live = async () => {
    const req = Object.assign(Readable.from([JSON.stringify(item)]), {
      headers: { host: "127.0.0.1:4456", authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST", url: "/api/inbox", socket: { remoteAddress: "127.0.0.1" },
    });
    let code = 0, reply = "";
    await server["route"](req as never, { writeHead(n: number) { code = n; },
      end(body: string) { reply = body; } } as never, "", "");
    assert.equal(code, 200, reply);
  };
  return { root, devices, device, store, pair, item, sub, errors, folder, server, live };
}

for (const route of ["folder", "AirDrop"] as const) {
  for (const outcome of ["accepted", "ignored"] as const) {
    test(`forged ${route} cannot poison a victim receipt even when ${outcome}`, async () => {
      const f = await fixture();
      try {
        const valid = JSON.parse(await folderItem(f.pair, f.item));
        const forged = signEnvelope({ ...valid, text: "Attacker's replacement." }, "b".repeat(64));
        if (route === "folder") {
          const path = join(f.sub, f.item.id + ".json");
          await writeFile(path, JSON.stringify(forged));
          await f.folder.scan();
          await f.folder.scan();
          assert.equal(f.errors.length, 1);
          assert.match(f.errors[0]!, /signature/);
          assert.equal(JSON.parse(await readFile(path, "utf8")).text, forged.text);
        } else {
          const path = join(f.root, "forged.coldopentakes");
          const batch = JSON.parse(await takesFile(f.pair, [f.item]));
          // Even a valid first take cannot be imported before a forged later take is checked.
          const first = JSON.parse(await folderItem(f.pair, { ...f.item, id: "receipt-987654321" }));
          await writeFile(path, JSON.stringify({ ...batch, takes: [first, forged] }));
          await assert.rejects(importTakesFile(path, f.devices, f.store, () => ({ title: "Draft" })), /signature/);
        }
        assert.deepEqual(await f.store.list(scriptId), []);
        await f.devices.decide(scriptId, f.item.id, outcome, f.device.id);
        assert.deepEqual(f.devices.decisions(f.device.id), {});
        const restored = new PhoneDevices(f.devices.path);
        await restored.load();
        assert.deepEqual(restored.decisions(f.device.id), {});
        await f.live();
        assert.equal((await f.store.list(scriptId))[0]?.text, f.item.text);
      } finally {
        await f.folder.stop(); await f.server.stop(); await rm(f.root, { recursive: true, force: true });
      }
    });
  }

  test(`phone-signed ${route} imports and deduplicates a later live delivery`, async () => {
    const f = await fixture();
    try {
      if (route === "folder") {
        await writeFile(join(f.sub, f.item.id + ".json"), await folderItem(f.pair, f.item));
        await f.folder.scan();
        assert.deepEqual(f.errors, []);
      } else {
        const path = join(f.root, "signed.coldopentakes");
        await writeFile(path, await takesFile(f.pair, [f.item]));
        assert.equal((await importTakesFile(path, f.devices, f.store, () => ({ title: "Draft" }))).added, 1);
      }
      await f.live();
      assert.equal((await f.store.list(scriptId)).length, 1);
    } finally {
      await f.folder.stop(); await f.server.stop(); await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("every signed field and missing, malformed, noncanonical or wrong signatures are refused", async () => {
  const f = await fixture();
  try {
    const payload = JSON.parse(await folderItem(f.pair, f.item));
    const other = await f.devices.create(scriptId, "127.0.0.1");
    const verify = f.devices.verifyTake.bind(f.devices);
    const changes = [{ deviceId: other.device.id }, { scriptId: "b".repeat(64) }, { id: "receipt-987654321" },
      { kind: "note" }, { text: "Changed." }, { paragraphId: "another-p" }, { sourceText: "Changed quote." },
      { sig: undefined }, { sig: null }, { sig: 4 }, { sig: "bad" }, { sig: "A".repeat(43) },
      { sig: payload.sig + "=" }];
    // Changing unused base64 padding bits must not create an alternate spelling of a valid signature.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    changes.push({ sig: payload.sig.slice(0, -1) + alphabet[alphabet.indexOf(payload.sig.at(-1)) + 1] });
    for (const change of changes) {
      const value = { ...payload, ...change };
      assert.throws(() => validateFolderItem(value, value.deviceId, value.scriptId, verify), /signature/);
    }
    assert.equal(validateFolderItem(payload, f.device.id, scriptId, verify).text, f.item.text);
    await f.devices.revoke(f.device.id);
    assert.throws(() => validateFolderItem(payload, f.device.id, scriptId, verify), /signature/);
    assert.throws(() => validateFolderItem({ ...payload, deviceId: "unknown-device" },
      "unknown-device", scriptId, verify), /signature/);
    assert.deepEqual(await f.store.list(scriptId), []);
  } finally {
    await f.folder.stop(); await f.server.stop(); await rm(f.root, { recursive: true, force: true });
  }
});
