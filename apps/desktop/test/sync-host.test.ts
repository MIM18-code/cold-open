// Hosting from the app: the embedded relay, the invites it hands out, and presence as the panel reads it.
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { test } from "node:test";

import { ScreenplayDoc, newId } from "@screenplay/engine";
import { RelayClient } from "@screenplay/relay/client";
import { parseInvite } from "@screenplay/relay/protocol";
import { Awareness } from "y-protocols/awareness";

import { Host, lanAddress } from "../src/main/sync/host.ts";
import { colorFor, hostDocName, participantsFrom, remoteCursorsFrom } from "../src/renderer/features/collab/presence.ts";

async function waitFor(check: () => boolean, what: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const portOpen = (port: number) => new Promise<boolean>((resolve) => {
  const socket = createConnection({ port, host: "127.0.0.1" });
  socket.once("connect", () => (socket.destroy(), resolve(true)));
  socket.once("error", () => resolve(false));
});

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null,
});

test("address picking prefers en* for LAN and leaves out only the address Tailscale reports", () => {
  const interfaces = {
    bridge0: [ipv4("10.0.0.2")],
    utun0: [ipv4("100.114.165.59")],
    en1: [ipv4("192.168.1.20")],
    en0: [ipv4("169.254.1.2"), ipv4("127.0.0.1", true)],
  };
  assert.equal(lanAddress(interfaces, "100.114.165.59"), "192.168.1.20");
  assert.equal(lanAddress({ utun0: interfaces.utun0 }, "100.114.165.59"), null);
  // Codex review: a carrier network or another VPN in 100.64.0.0/10 is an ordinary address when Tailscale doesn't own it.
  assert.equal(lanAddress({ utun0: interfaces.utun0 }), "100.114.165.59");
  assert.equal(lanAddress({ bridge0: interfaces.bridge0 }), "10.0.0.2");
  const ipv6: NetworkInterfaceInfo = { ...ipv4("fd7a:115c:a1e0::1"), family: "IPv6", scopeid: 0 };
  assert.equal(lanAddress({ en0: [ipv6] }), null);
});

test("the Tailscale address comes from Tailscale's own status, not the address range", async () => {
  const { tailscaleOwnAddress } = await import("../src/main/phone/tailscale.ts");
  const status = (state: string, ips: string[]) => JSON.stringify({ BackendState: state, Self: { TailscaleIPs: ips, DNSName: "mac.tail1.ts.net." } });
  assert.equal(await tailscaleOwnAddress(async () => status("Running", ["100.114.165.59", "fd7a:115c:a1e0::1"])), "100.114.165.59");
  assert.equal(await tailscaleOwnAddress(async () => status("Stopped", ["100.114.165.59"])), null);
  assert.equal(await tailscaleOwnAddress(async () => { throw new Error("no CLI"); }), null);
});

for (const [name, lan, tail] of [
  ["LAN and Tailscale", "192.168.1.20", "100.114.165.59"],
  ["LAN only", "192.168.1.20", null],
  ["Tailscale only", null, "100.114.165.59"],
  ["no network", null, null],
] as const) {
  test(`Host.start advertises ${name} with the same room and keys`, async (t) => {
    const host = new Host("127.0.0.1", { networkInterfaces: () => ({
      en0: lan ? [ipv4(lan)] : [], utun0: tail ? [ipv4(tail)] : [],
    }), tailscale: async () => tail });
    t.after(() => host.close());
    const info = await host.start(1);
    const port = new URL(info.relay).port;
    const write = parseInvite(info.invite);
    const read = parseInvite(info.readOnlyInvite);
    assert.equal(info.lan, !!lan);
    assert.equal(info.address, `${lan ?? tail ?? "127.0.0.1"}:${port}`);
    assert.deepEqual(write, { relay: `ws://${info.address}`, room: info.room, key: info.key, readOnly: false });
    assert.equal(read.room, info.room);
    assert.equal(read.readOnly, true);
    assert.notEqual(read.key, write.key);
    if (tail) {
      assert.ok(info.tailscale);
      assert.equal(info.tailscale.address, `${tail}:${port}`);
      assert.deepEqual(parseInvite(info.tailscale.invite), { ...write, relay: `ws://${tail}:${port}` });
      assert.deepEqual(parseInvite(info.tailscale.readOnlyInvite), { ...read, relay: `ws://${tail}:${port}` });
      if (!lan) assert.equal(info.invite, info.tailscale.invite);
    } else assert.equal(info.tailscale, null);
    assert.deepEqual(await host.start(1), info, "sharing again keeps the room and invites");
  });
}

test("a client using the second invite joins the host's existing room", async (t) => {
  const host = new Host("127.0.0.1", { networkInterfaces: () => ({
    en0: [ipv4("192.168.1.20")], utun0: [ipv4("100.114.165.59")],
  }), tailscale: async () => "100.114.165.59" });
  const clients: RelayClient[] = [];
  const script = new ScreenplayDoc();
  const guestDoc = new ScreenplayDoc();
  t.after(async () => {
    for (const client of clients) client.destroy();
    script.ydoc.destroy();
    guestDoc.ydoc.destroy();
    await host.close();
  });
  const info = await host.start(1);
  script.insertParagraph(0, { type: "action", runs: [{ text: "Shared over either address." }] });
  const hostClient = new RelayClient({ relay: info.relay, room: info.room, key: info.key, doc: script.ydoc });
  clients.push(hostClient);
  await hostClient.whenSynced();
  assert.ok(info.tailscale);
  const invite = parseInvite(info.tailscale.invite);
  // Resolve the fake Tailscale address to loopback while keeping the invite's port, room and key.
  class LoopbackSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const endpoint = new URL(url);
      assert.equal(endpoint.hostname, "100.114.165.59");
      endpoint.hostname = "127.0.0.1";
      super(endpoint, protocols);
    }
  }
  const guest = new RelayClient({ ...invite, doc: guestDoc.ydoc, WebSocket: LoopbackSocket });
  clients.push(guest);
  await guest.whenSynced();
  assert.deepEqual(guestDoc.toScript(), script.toScript());
  guestDoc.insertParagraph(1, { type: "action", runs: [{ text: "The guest writes back." }] });
  await waitFor(() => script.toScript().paragraphs.length === 2, "the guest's edit in the same room");
  assert.deepEqual(script.toScript(), guestDoc.toScript());
});

test("a hosted session: the host's script reaches a guest, edits flow both ways, a read-only invite cannot edit", async (t) => {
  const host = new Host("127.0.0.1");
  const clients: RelayClient[] = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    await host.close();
  });
  const info = await host.start(1);
  assert.equal(info.lan, false);
  assert.match(info.invite, /^screenplay:\/\/join\?host=127\.0\.0\.1%3A\d+&room=[\w-]{22}&key=[\w-]{22}$/);
  assert.match(info.readOnlyInvite, /&access=read$/);

  const script = ScreenplayDoc.fromScript({ titlePage: [], paragraphs: [{ id: newId(), type: "sceneHeading", runs: [{ text: "INT. GARAGE - NIGHT" }] }] });
  const hostClient = new RelayClient({ relay: info.relay, room: info.room, key: info.key, doc: script.ydoc });
  clients.push(hostClient);
  await hostClient.whenSynced();

  const write = parseInvite(info.invite);
  const guestDoc = new ScreenplayDoc();
  const guest = new RelayClient({ relay: write.relay, room: write.room, key: write.key, doc: guestDoc.ydoc });
  clients.push(guest);
  await guest.whenSynced();
  assert.deepEqual(guestDoc.toScript(), script.toScript());

  const heading = script.toScript().paragraphs[0]!.id;
  guestDoc.ydoc.transact(() => guestDoc.insertParagraph(1, { type: "action", runs: [{ text: "A car idles." }] }));
  // At the heading's start: an insert at its end would race the guest's new paragraph for the same spot.
  script.insertText(heading, 0, "FLASHBACK - ");
  await waitFor(() => JSON.stringify(guestDoc.toScript()) === JSON.stringify(script.toScript()) && script.toScript().paragraphs.length === 2, "convergence");
  assert.equal(guestDoc.toScript().paragraphs[0]!.runs[0]!.text, "FLASHBACK - INT. GARAGE - NIGHT");

  const read = parseInvite(info.readOnlyInvite);
  assert.equal(read.readOnly, true);
  const readerDoc = new ScreenplayDoc();
  const reader = new RelayClient({ relay: read.relay, room: read.room, key: read.key, doc: readerDoc.ydoc, readOnly: read.readOnly });
  clients.push(reader);
  await reader.whenSynced();
  assert.equal(readerDoc.toScript().paragraphs.length, 2);
  readerDoc.insertParagraph(2, { type: "action", runs: [{ text: "Not allowed." }] });
  guestDoc.insertParagraph(2, { type: "action", runs: [{ text: "Allowed." }] });
  await waitFor(() => script.toScript().paragraphs.length === 3, "the guest's edit");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!JSON.stringify(script.toScript()).includes("Not allowed."));

  // A second window hosting gets its own room on the same relay.
  const second = await host.start(2);
  assert.notEqual(second.room, info.room);
  assert.equal(second.relay, info.relay);
  await host.stop(2);

  await host.stop(1);
  await waitFor(() => guest.status === "ended" && reader.status === "ended", "the session to end");
  const port = Number(new URL(info.relay).port);
  assert.equal(await portOpen(port), false, "the relay stops listening once nobody hosts");
});

test("presence lists writers and their carets, and ignores malformed states", () => {
  const states = new Map<number, unknown>([
    [7, { user: { name: "Zoe", color: "#2f6fdf" }, cursor: { anchor: { paragraphId: "p1", offset: 2 }, head: { paragraphId: "p1", offset: 5 } }, doc: { name: "Pilot" } }],
    [3, { user: { name: "Me", color: "#b5442c" }, cursor: { anchor: { paragraphId: "p2", offset: 0 }, head: { paragraphId: "p2", offset: 0 } } }],
    [9, { user: { name: "Backlot", color: "not a color", readOnly: true }, cursor: null }],
    [11, { cursor: { anchor: { paragraphId: "p1", offset: 1 } } }],
    [12, { user: { name: "Bad caret", color: "#000000" }, cursor: { anchor: { paragraphId: "p1", offset: -1 }, head: { paragraphId: "p1", offset: 0 } } }],
  ]);
  const people = participantsFrom(states, 3);
  assert.deepEqual(people.map((p) => p.name), ["Me", "Backlot", "Bad caret", "Zoe"]);
  assert.equal(people[1]!.color, colorFor(9));
  assert.equal(people[1]!.readOnly, true);
  assert.equal(people.find((p) => p.name === "Zoe")!.host, true);
  const cursors = remoteCursorsFrom(states, 3);
  assert.deepEqual(cursors, [{ clientId: 7, name: "Zoe", color: "#2f6fdf", anchor: { paragraphId: "p1", offset: 2 }, head: { paragraphId: "p1", offset: 5 } }]);
  assert.equal(hostDocName(states, 3), "Pilot");
  assert.equal(hostDocName(states, 7), null);
});

test("awareness carries presence between two clients through the hosted relay", async () => {
  const host = new Host("127.0.0.1");
  const info = await host.start(1);
  const a = new ScreenplayDoc();
  const b = new ScreenplayDoc();
  const awarenessA = new Awareness(a.ydoc);
  const awarenessB = new Awareness(b.ydoc);
  awarenessA.setLocalState({ user: { name: "Ana", color: colorFor(awarenessA.clientID) }, cursor: null, doc: { name: "Pilot" } });
  awarenessB.setLocalState({ user: { name: "Ben", color: colorFor(awarenessB.clientID) }, cursor: null });
  const clientA = new RelayClient({ relay: info.relay, room: info.room, key: info.key, doc: a.ydoc, awareness: awarenessA });
  const clientB = new RelayClient({ relay: info.relay, room: info.room, key: info.key, doc: b.ydoc, awareness: awarenessB });
  await waitFor(() => participantsFrom(awarenessB.getStates(), awarenessB.clientID).length === 2, "both writers listed");
  awarenessA.setLocalStateField("cursor", { anchor: { paragraphId: "x", offset: 1 }, head: { paragraphId: "x", offset: 4 } });
  await waitFor(() => remoteCursorsFrom(awarenessB.getStates(), awarenessB.clientID)[0]?.head.offset === 4, "the caret");
  assert.equal(hostDocName(awarenessB.getStates(), awarenessB.clientID), "Pilot");
  clientA.destroy();
  await waitFor(() => participantsFrom(awarenessB.getStates(), awarenessB.clientID).length === 1, "Ana leaving");
  clientB.destroy();
  awarenessA.destroy();
  awarenessB.destroy();
  await host.close();
});
