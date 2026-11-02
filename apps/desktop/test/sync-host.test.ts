// Hosting from the app: the embedded relay, the invites it hands out, and presence as the panel reads it.
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { test } from "node:test";

import { ScreenplayDoc, newId } from "@screenplay/engine";
import { RelayClient } from "@screenplay/relay/client";
import { parseInvite } from "@screenplay/relay/protocol";
import { Awareness } from "y-protocols/awareness";

import { Host } from "../src/main/sync/host.ts";
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
