import { signEnvelope } from "./phone-signing.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PhoneDevices, matchesToken } from "../src/main/phone/devices.ts";
import { PhoneFolder, FolderGuard, validateFolderItem } from "../src/main/phone/folder.ts";
import { PhoneInboxStore } from "../src/main/phone/inbox.ts";
import { tailAddress, tailName, tailStatus, tailStatusFields, tailscaleCheck, tailscaleNetwork, tailscaleTls } from "../src/main/phone/tailscale.ts";
import { openForRead } from "../src/main/safe-fs.ts";
import type { PhoneInbox } from "../src/shared/channels/phone.ts";

const scriptId = "a".repeat(64);
const item: PhoneInbox = { id: "receipt-123456789", kind: "note", text: "A road note.", paragraphId: "p",
  sourceText: "A passage.", cueId: "", revision: "v1", created: new Date().toISOString() };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "phone-away-"));
  const state = join(root, "state.json"), devices = new PhoneDevices(state);
  await devices.load();
  const { device, token } = await devices.create(scriptId, "100.114.165.59", "mac.tail123.ts.net");
  const store = new PhoneInboxStore(join(root, "inbox"));
  return { root, state, devices, device, token, store };
}

test("Tailscale discovery validates MagicDNS and CGNAT and never interpolates a shell command", async () => {
  for (const address of ["100.64.0.0", "100.114.165.59", "100.127.255.255"]) assert.ok(tailAddress(address));
  for (const address of ["100.63.255.255", "100.128.0.0", "100.64.999.1", "100.64.0.1;touch x"]) assert.ok(!tailAddress(address));
  assert.ok(tailName("mac.tail123.ts.net"));
  for (const name of ["-mac.ts.net", "mac.ts.net.evil.com", "mac;foo.ts.net", "*.ts.net"]) assert.ok(!tailName(name));
  assert.deepEqual(tailStatus(JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "x.ts.net" } })), {});
  assert.deepEqual(tailStatusFields(JSON.stringify({ BackendState: "Running" })),
    { running: true, magicDns: false, https: false });
  assert.deepEqual(tailStatusFields(JSON.stringify({ BackendState: "Stopped",
    CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: ["mac.tail123.ts.net"] })),
  { running: false, magicDns: true, https: true });
  const calls: string[][] = [];
  const network = await tailscaleNetwork(async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail123.ts.net." } });
    return "100.114.165.59\n";
  });
  assert.equal(network?.hostname, "mac.tail123.ts.net");
  assert.equal(network?.address, "100.114.165.59");
  assert.deepEqual(calls.map(c => c.slice(1)), [["status", "--json"], ["ip", "-4"]]);
  assert.deepEqual(await tailscaleCheck(async () => JSON.stringify({ BackendState: "Running",
    CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: ["mac.tail123.ts.net"] })),
  { installed: true, running: true, magicDns: true, https: true });
  assert.deepEqual(await tailscaleCheck(async () => { throw new Error("No CLI installed"); }),
    { installed: false, running: false, magicDns: false, https: false });
});

test("Tailscale cert uses validated argv and main-only temporary files, and fails with HTTPS enable instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-tail-tls-"));
  try {
    const key = join(root, "test.key"), cert = join(root, "test.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key,
      "-out", cert, "-subj", "/CN=mac.tail123.ts.net", "-addext", "subjectAltName=DNS:mac.tail123.ts.net",
      "-addext", "basicConstraints=critical,CA:FALSE"], { stdio: "ignore" });
    const network = { address: "100.114.165.59", hostname: "mac.tail123.ts.net", cli: "/usr/local/bin/tailscale",
      tailscale: true as const, name: "Tailscale" };
    const tls = await tailscaleTls(root, network, async (file, args) => {
      assert.equal(file, network.cli); assert.equal(args[0], "cert"); assert.equal(args[3], network.hostname);
      await writeFile(args[1]!.slice("--cert-file=".length), await readFile(cert));
      await writeFile(args[2]!.slice("--key-file=".length), await readFile(key));
      return "";
    });
    assert.ok(tls.info.fingerprint); assert.ok(!JSON.stringify(tls.info).includes("PRIVATE KEY"));
    assert.ok(!(await readdir(root)).some(n => n.startsWith("phone-tls-")));
    await assert.rejects(tailscaleTls(root, network, async () => { throw new Error("private CLI output"); }),
      e => e instanceof Error && /Enable HTTPS/.test(e.message) && !/private CLI output/.test(e.message));
    await assert.rejects(tailscaleTls(root, { ...network, hostname: "--bad.ts.net" }, async () => {
      assert.fail("Unvalidated host reached the CLI");
    }), /MagicDNS/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("remembered credentials, names and receipts survive restart, deduplicate both transports and revoke", async () => {
  const f = await fixture();
  try {
    const raw = await readFile(f.state, "utf8");
    assert.ok(!raw.includes(f.token)); assert.ok(matchesToken(f.token, f.device.tokenHash));
    assert.ok(!matchesToken("wrong", f.device.tokenHash));
    await f.devices.seen(f.device.id, "Maya’s iPhone");
    await Promise.all([f.devices.receive(f.device.id, scriptId, item, f.store),
      f.devices.receive(f.device.id, scriptId, item, f.store)]);
    assert.equal((await f.store.list(scriptId)).length, 1);
    await f.devices.decide(scriptId, item.id, "accepted", f.device.id); await f.store.remove(scriptId, item.id, f.device.id);
    const reopened = new PhoneDevices(f.state); await reopened.load();
    assert.equal(reopened.device(f.device.id)?.name, "Maya’s iPhone");
    assert.ok(reopened.device(f.device.id)!.lastSeen > 0);
    await reopened.receive(f.device.id, scriptId, item, f.store);
    assert.equal((await f.store.list(scriptId)).length, 0);
    assert.equal(reopened.decisions(f.device.id)[item.id]?.outcome, "accepted");
    await assert.rejects(reopened.receive(f.device.id, scriptId, { ...item, text: "Changed" }, f.store), /already used/);
    await assert.rejects(reopened.receive(f.device.id, "b".repeat(64), item, f.store), /not paired/);
    await reopened.revoke(f.device.id);
    const revoked = new PhoneDevices(f.state); await revoked.load();
    assert.equal(revoked.device(f.device.id)?.revoked, true);
    await assert.rejects(revoked.receive(f.device.id, scriptId, item, f.store), /not paired/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("folder imports only validated remembered-script items, including while that script is closed", async () => {
  const f = await fixture(); let folder: PhoneFolder | undefined;
  try {
    const picked = join(f.root, "cloud"), devicePath = join(picked, "Inklot Phone Inbox", f.device.id);
    await mkdir(devicePath, { recursive: true });
    const payload = signEnvelope({ v: 1, deviceId: f.device.id, scriptId, id: item.id, kind: item.kind, text: item.text,
      paragraphId: item.paragraphId, sourceText: item.sourceText }, f.device.tokenHash);
    const errors: string[] = [];
    folder = new PhoneFolder(picked, f.devices, f.store, () => {}, e => errors.push(e));
    const path = join(devicePath, item.id + ".json");
    await writeFile(path, JSON.stringify(payload));
    await folder.start();
    assert.equal((await f.store.list(scriptId)).length, 1);
    assert.ok(!(await readdir(devicePath)).includes(item.id + ".json"));
    await f.devices.decide(scriptId, item.id, "ignored", f.device.id); await f.store.remove(scriptId, item.id, f.device.id);
    await writeFile(path, JSON.stringify(payload)); await folder.scan();
    await f.devices.receive(f.device.id, scriptId, item, f.store);
    assert.equal((await f.store.list(scriptId)).length, 0);
    assert.equal(f.devices.decisions(f.device.id)[item.id]?.outcome, "ignored");
    for (const change of [{ scriptId: "b".repeat(64) }, { deviceId: "unknown-device" }, { kind: "draft", paragraphId: "" },
      { text: "字".repeat(20000) }, { text: 4 }, { kind: "bookmark" }, { id: "../bad" }])
      assert.throws(() => validateFolderItem({ ...payload, ...change }, f.device.id, scriptId,
        f.devices.verifyTake.bind(f.devices)));
    const loose = signEnvelope({ v: 1, deviceId: f.device.id, scriptId, id: "loose-note-000001", kind: "note", text: "Lamp on the water.",
      paragraphId: "", sourceText: "" }, f.device.tokenHash);
    assert.equal(validateFolderItem(loose, f.device.id, scriptId, f.devices.verifyTake.bind(f.devices)).paragraphId, "");
    await writeFile(path, JSON.stringify({ ...payload, scriptId: "b".repeat(64) })); await folder.scan();
    assert.ok(errors.some(e => e.includes("Invalid phone inbox")));
    await f.devices.revoke(f.device.id);
    await writeFile(path, JSON.stringify(payload)); await folder.scan();
    assert.equal((await f.store.list(scriptId)).length, 0);
  } finally { await folder?.stop(); await rm(f.root, { recursive: true, force: true }); }
});

test("folder scanner refuses links, hard links, FIFOs, oversize and malformed files and a replaced root", async () => {
  const f = await fixture(); let folder: PhoneFolder | undefined;
  try {
    const picked = join(f.root, "cloud"), sub = join(picked, "Inklot Phone Inbox", f.device.id);
    await mkdir(sub, { recursive: true });
    const outside = join(f.root, "outside.json");
    await writeFile(outside, "{}");
    await symlink(outside, join(sub, "linked-receipt-123.json"));
    await link(outside, join(sub, "hardlink-receipt-123.json"));
    execFileSync("mkfifo", [join(sub, "fifo-receipt-123.json")]);
    await writeFile(join(sub, "oversize-receipt-123.json"), "x".repeat(26001));
    await writeFile(join(sub, "partial-receipt-123.json"), "{");
    const errors: string[] = [];
    folder = new PhoneFolder(picked, f.devices, f.store, () => {}, e => errors.push(e));
    await folder.start();
    assert.equal((await f.store.list(scriptId)).length, 0);
    assert.ok(errors.length >= 5);
    assert.equal(await readFile(outside, "utf8"), "{}");
    const original = picked + "-original";
    await rename(picked, original); await symlink(original, picked);
    assert.throws(() => new FolderGuard(picked), /real directory/);
    await folder.scan(); assert.ok(errors.some(e => e.includes("became a link")));
    await folder.stop();
    await rm(picked); await mkdir(picked);
    await symlink(join(original, "Inklot Phone Inbox"), join(picked, "Inklot Phone Inbox"));
    folder = new PhoneFolder(picked, f.devices, f.store, () => {}, e => errors.push(e));
    await assert.rejects(folder.start(), /real directory/);
  } finally { await folder?.stop(); await rm(f.root, { recursive: true, force: true }); }
});


test("bounded reads reject a file that grew after its descriptor was inspected", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-growing-"));
  const path = join(root, "growing.json");
  try {
    await writeFile(path, "{}");
    const file = await openForRead(path);
    assert.ok(file); assert.equal(file.info.size, 2);
    try {
      await writeFile(path, "x".repeat(26001));
      await assert.rejects(file.read(26000), /size limit/);
    } finally { await file.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("a persisted folder grant refuses a redirected ancestor after restarting", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-folder-grant-"));
  try {
    const parent = join(root, "parent"), picked = join(parent, "picked");
    await mkdir(picked, { recursive: true });
    const grant = new FolderGuard(picked).grant();
    await rename(parent, parent + "-old");
    const outside = join(root, "other");
    await mkdir(join(outside, "picked"), { recursive: true });
    await symlink(outside, parent);
    assert.throws(() => new FolderGuard(picked, grant), /granted phone folder changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("typed drafts import from the folder, survive inbox reopen and retain review receipts", async () => {
  const f = await fixture(); let folder: PhoneFolder | undefined;
  try {
    const picked = join(f.root, "cloud"), sub = join(picked, "Inklot Phone Inbox", f.device.id);
    await mkdir(sub, { recursive: true });
    const payload = signEnvelope({ v: 1, deviceId: f.device.id, scriptId, id: item.id, kind: "draft",
      text: "INT. KITCHEN - DAY\n\nMARA\n(quietly)\nClose the door.",
      paragraphId: "p", sourceText: "A passage." }, f.device.tokenHash);
    const path = join(sub, item.id + ".json"), errors: string[] = [];
    await writeFile(path, JSON.stringify(payload));
    folder = new PhoneFolder(picked, f.devices, f.store, () => {}, e => errors.push(e));
    await folder.scan();
    const reopened = new PhoneInboxStore(join(f.root, "inbox"));
    assert.equal((await reopened.list(scriptId))[0]?.kind, "draft");
    assert.equal((await reopened.list(scriptId))[0]?.text, payload.text);
    await f.devices.decide(scriptId, item.id, "accepted", f.device.id); await f.store.remove(scriptId, item.id, f.device.id);
    await writeFile(path, JSON.stringify(payload)); await folder.scan();
    const inbox = validateFolderItem(payload, f.device.id, scriptId, f.devices.verifyTake.bind(f.devices));
    await f.devices.receive(f.device.id, scriptId, inbox, f.store);
    assert.equal((await f.store.list(scriptId)).length, 0);
    assert.equal(f.devices.decisions(f.device.id)[item.id]?.outcome, "accepted");
    assert.deepEqual(errors, []);
  } finally { await folder?.stop(); await rm(f.root, { recursive: true, force: true }); }
});
