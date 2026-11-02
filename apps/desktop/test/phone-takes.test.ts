import { signEnvelope } from "./phone-signing.ts";
import type { RememberedPhone } from "../src/main/phone/devices.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneDevices } from "../src/main/phone/devices.ts";
import { PhoneInboxStore } from "../src/main/phone/inbox.ts";
import { importTakesFile, isTakesFileName, takesFileExtension, takesFileLimit } from "../src/main/phone/takes.ts";

const scriptId = "a".repeat(64);
const otherScriptId = "b".repeat(64);
const take = (id: string, text = "A road note.") =>
  ({ id, kind: "note" as const, text, paragraphId: "p", sourceText: "A passage." });
const takesFile = (device: RememberedPhone | string, identity: string, takes: object[]) => {
  const deviceId = typeof device === "string" ? device : device.id;
  return JSON.stringify({ v: 1, deviceId, scriptId: identity, takes: takes.map(take =>
    typeof device === "string" ? take : signEnvelope({ ...take, deviceId, scriptId: identity }, device.tokenHash)) });
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "phone-takes-"));
  const devices = new PhoneDevices(join(root, "devices.json"));
  await devices.load();
  const { device } = await devices.create(scriptId, "100.114.165.59", "mac.tail123.ts.net");
  const store = new PhoneInboxStore(join(root, "inbox"));
  return { root, devices, device, store };
}
async function file(root: string, name: string, data: string) {
  const path = join(root, name);
  await writeFile(path, data);
  return path;
}

test("a takes file from a remembered iPhone lands in its script inbox with one receipt per take", async () => {
  const f = await fixture();
  try {
    const path = await file(f.root, "Cold Open takes 2026-10-31.coldopentakes",
      takesFile(f.device, scriptId, [take("receipt-000000001"), take("receipt-000000002", "Second.")]));
    const result = await importTakesFile(path, f.devices, f.store,
      id => id === scriptId ? { title: "Draft" } : undefined);
    assert.equal(result.added, 2);
    assert.equal(result.title, "Draft");
    assert.equal(result.scriptId, scriptId);
    assert.deepEqual((await f.store.list(scriptId)).map(row => row.id).sort(),
      ["receipt-000000001", "receipt-000000002"]);
    assert.deepEqual(Object.keys(f.devices.decisions(f.device.id)), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a takes file made before the rename (.inklottakes) still imports, and Finder hands over either name", async () => {
  assert.equal(takesFileExtension, ".coldopentakes");
  assert.equal(isTakesFileName("/tmp/Cold Open takes 2026-10-31.coldopentakes"), true);
  assert.equal(isTakesFileName("/tmp/Inklot takes 2026-10-31.INKLOTTAKES"), true);
  assert.equal(isTakesFileName("/tmp/notes.json"), false);
  const f = await fixture();
  try {
    const path = await file(f.root, "Inklot takes 2026-10-30.inklottakes",
      takesFile(f.device, scriptId, [take("receipt-000000011")]));
    const result = await importTakesFile(path, f.devices, f.store, id => id === scriptId ? { title: "Draft" } : undefined);
    assert.equal(result.added, 1);
    assert.deepEqual((await f.store.list(scriptId)).map(row => row.id), ["receipt-000000011"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("duplicate receipt IDs are imported once, whether they arrived live, by iCloud or by AirDrop", async () => {
  const f = await fixture();
  try {
    const path = await file(f.root, "again.coldopentakes",
      takesFile(f.device, scriptId, [take("receipt-000000001"), take("receipt-000000002")]));
    const open = (id: string) => id === scriptId ? { title: "Draft" } : undefined;
    assert.equal((await importTakesFile(path, f.devices, f.store, open)).added, 2);
    assert.equal((await importTakesFile(path, f.devices, f.store, open)).added, 0);
    assert.equal((await f.store.list(scriptId)).length, 2);
    const live = { ...take("receipt-000000003"), cueId: "", revision: "phone-live", created: new Date().toISOString() };
    assert.equal(await f.devices.receive(f.device.id, scriptId, live, f.store), true);
    await file(f.root, "live.coldopentakes", takesFile(f.device, scriptId, [take("receipt-000000003")]));
    const liveFile = join(f.root, "live.coldopentakes");
    assert.equal((await importTakesFile(liveFile, f.devices, f.store, open)).added, 0);
    assert.equal((await f.store.list(scriptId)).length, 3);
    // A reviewed take stays reviewed: re-import cannot recreate it.
    await f.devices.decide(scriptId, "receipt-000000001", "ignored", f.device.id);
    await f.store.remove(scriptId, "receipt-000000001", f.device.id);
    const reviewed = await file(f.root, "reviewed.coldopentakes",
      takesFile(f.device, scriptId, [take("receipt-000000001")]));
    assert.equal((await importTakesFile(reviewed, f.devices, f.store, open)).added, 0);
    assert.equal((await f.store.list(scriptId)).some(row => row.id === "receipt-000000001"), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a takes file from an unknown or revoked iPhone is refused", async () => {
  const f = await fixture();
  try {
    const unknown = await file(f.root, "unknown.coldopentakes",
      takesFile("device-000000000", scriptId, [take("receipt-000000001")]));
    await assert.rejects(importTakesFile(unknown, f.devices, f.store, () => ({ title: "Draft" })),
      /no longer remembers/);
    await f.devices.revoke(f.device.id);
    const revoked = await file(f.root, "revoked.coldopentakes",
      takesFile(f.device, scriptId, [take("receipt-000000001")]));
    await assert.rejects(importTakesFile(revoked, f.devices, f.store, () => ({ title: "Draft" })),
      /no longer remembers/);
    assert.equal((await f.store.list(scriptId)).length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a takes file for another script, or for a script no window has open, is refused", async () => {
  const f = await fixture();
  try {
    const other = await file(f.root, "other.coldopentakes",
      takesFile(f.device, otherScriptId, [take("receipt-000000001")]));
    await assert.rejects(importTakesFile(other, f.devices, f.store, () => ({ title: "Draft" })),
      /different script/);
    const closed = await file(f.root, "closed.coldopentakes",
      takesFile(f.device, scriptId, [take("receipt-000000001")]));
    await assert.rejects(importTakesFile(closed, f.devices, f.store, () => undefined),
      /Open the script/);
    assert.equal((await f.store.list(scriptId)).length, 0);
    assert.equal((await f.store.list(otherScriptId)).length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("oversized and malformed takes files change nothing", async () => {
  const f = await fixture();
  try {
    const open = () => ({ title: "Draft" });
    const oversize = await file(f.root, "oversize.coldopentakes", "x".repeat(takesFileLimit + 1));
    await assert.rejects(importTakesFile(oversize, f.devices, f.store, open), /too large/);
    const malformed: [string, string][] = [
      ["broken", "{"],
      ["array", "[]"],
      ["version", JSON.stringify({ v: 2, deviceId: f.device.id, scriptId, takes: [take("receipt-000000001")] })],
      ["device", takesFile("../bad", scriptId, [take("receipt-000000001")])],
      ["script", takesFile(f.device, "not-a-script", [take("receipt-000000001")])],
      ["empty", takesFile(f.device, scriptId, [])],
      ["many", takesFile(f.device, scriptId,
        Array.from({ length: 101 }, (_, i) => take(`receipt-${String(i).padStart(9, "0")}`)))],
      ["bad receipt", takesFile(f.device, scriptId, [{ ...take("short"), id: "../bad" }])],
      ["bad kind", takesFile(f.device, scriptId, [{ ...take("receipt-000000001"), kind: "bookmark" }])],
      ["no text", takesFile(f.device, scriptId, [{ ...take("receipt-000000001"), text: "  " }])],
      ["long text", takesFile(f.device, scriptId, [{ ...take("receipt-000000001"), text: "字".repeat(20000) }])],
    ];
    for (const [name, data] of malformed) {
      const path = await file(f.root, name + ".coldopentakes", data);
      await assert.rejects(importTakesFile(path, f.devices, f.store, open),
        /not a Cold Open takes file|not a valid Cold Open takes file|Invalid phone inbox file/, name);
    }
    assert.equal((await f.store.list(scriptId)).length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a take cannot name a different iPhone or script inside the file envelope", async () => {
  const f = await fixture();
  try {
    const path = await file(f.root, "spoof.coldopentakes", takesFile(f.device, scriptId,
      [{ ...take("receipt-000000001"), deviceId: "device-000000000", scriptId: otherScriptId }]));
    const result = await importTakesFile(path, f.devices, f.store, () => ({ title: "Draft" }));
    assert.equal(result.added, 1);
    assert.equal((await f.store.list(scriptId)).length, 1);
    assert.equal((await f.store.list(otherScriptId)).length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
