// A sealed reader listener over real sockets on 127.0.0.1: what crosses the wire, who gets in, and which close
// codes a reader believes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { after, test } from "node:test";

import { WebSocket as NodeSocket, WebSocketServer } from "ws";
import * as Y from "yjs";

import { RelayClient } from "../src/client.ts";
import { createRelay, type Relay } from "../src/relay.ts";
import { hello, linkKeys, linkRoot, sealedPath, sealedWebSocket, type LinkKeys } from "../src/sealed.ts";

const closers: (() => Promise<void> | void)[] = [];
after(async () => { for (const close of closers.reverse()) await close(); });

async function waitFor(check: () => boolean, what: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Every byte the listener receives and sends, as someone on the network would see them. */
function tap(server: Server) {
  const received: Buffer[] = [], sent: Buffer[] = [];
  server.on("connection", (socket: Socket) => {
    socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
    const write = socket.write.bind(socket);
    socket.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sent.push(Buffer.from(chunk as Uint8Array));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof socket.write;
  });
  return { received: () => Buffer.concat(received), sent: () => Buffer.concat(sent) };
}

async function sealedListener(extra: { wait?: boolean; limits?: Partial<Parameters<typeof createRelay>[0]> } = {}) {
  const keys = linkKeys(linkRoot(randomBytes(32).toString("base64url")));
  const server = createServer((_request, response) => response.writeHead(404).end());
  const wire = tap(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const relay: Relay = await createRelay({ readerServer: server, readerSealed: (id) => id === keys.id ? keys : undefined,
    ...(extra.wait ? { readerWaitForRoom: true } : {}), ...extra.limits });
  closers.push(async () => { await relay.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { keys, relay, url, wire };
}

function reader(url: string, room: string, key: string, keys: LinkKeys | null) {
  const client = new RelayClient({ relay: url, room, key, doc: new Y.Doc(), readOnly: true, maxBackoff: 100,
    ...(keys ? { WebSocket: sealedWebSocket(keys, NodeSocket as unknown as typeof WebSocket) } : {}) });
  closers.push(() => client.destroy());
  return client;
}

function writer(relay: Relay, room: string, key: string) {
  const client = new RelayClient({ relay: `ws://127.0.0.1:${relay.port}`, room, key, doc: new Y.Doc() });
  closers.push(() => client.destroy());
  return client;
}

test("a sealed reader follows the script, and the wire shows none of it", async () => {
  const { keys, relay, url, wire } = await sealedListener();
  const { room, key, readKey } = relay.createRoom();
  const host = writer(relay, room, key);
  await host.whenSynced();
  host.doc.getText("body").insert(0, "INT. LIGHTHOUSE - NIGHT. MARGUERITE climbs the stairs.");
  const phone = reader(url, room, readKey, keys);
  phone.awareness.setLocalState({ user: { name: "Cold Open Remote" } });
  await phone.whenSynced();
  await waitFor(() => phone.doc.getText("body").toString().includes("MARGUERITE"), "the script");
  host.doc.getText("body").insert(0, "FADE IN: on the HARBOUR. ");
  await waitFor(() => phone.doc.getText("body").toString().startsWith("FADE IN"), "a live edit");
  await waitFor(() => [...host.awareness.getStates().values()].some((state) => state.user?.name === "Cold Open Remote"), "presence");

  const up = wire.received(), down = wire.sent();
  assert.ok(up.includes(`GET ${sealedPath(keys)} HTTP/1.1`), "the tap sees the upgrade request");
  assert.ok(down.length > 200 && up.length > 200);
  for (const secret of [room, readKey, key, "LIGHTHOUSE", "MARGUERITE", "HARBOUR", "FADE IN", "Cold Open Remote"]) {
    assert.ok(!up.includes(secret), `phone to Mac shows ${secret}`);
    assert.ok(!down.includes(secret), `Mac to phone shows ${secret}`);
  }
  assert.ok(!up.includes(Buffer.from(keys.root)) && !down.includes(Buffer.from(keys.root)));

  // The same tap on a plain reader listener does show the key and the script, so it would catch a leak.
  const server = createServer((_request, response) => response.writeHead(404).end());
  const plainWire = tap(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const plainRelay = await createRelay({ readerServer: server });
  closers.push(async () => { await plainRelay.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const open = plainRelay.createRoom();
  const plainHost = writer(plainRelay, open.room, open.key);
  await plainHost.whenSynced();
  plainHost.doc.getText("body").insert(0, "INT. LIGHTHOUSE - NIGHT");
  const plainPhone = reader(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, open.room, open.readKey, null);
  await plainPhone.whenSynced();
  assert.ok(plainWire.received().includes(open.readKey) && plainWire.sent().includes("LIGHTHOUSE"));
});

test("a sealed listener refuses plain readers and other pairings", async () => {
  const { keys, relay, url } = await sealedListener();
  const { room, readKey, key } = relay.createRoom();
  const host = writer(relay, room, key);
  await host.whenSynced();
  host.doc.getText("body").insert(0, "secret pages");

  const plain = reader(url, room, readKey, null);
  await waitFor(() => plain.status === "denied", "a plain reader to be refused");
  assert.equal(plain.doc.getText("body").toString(), "");

  // A phone paired with another Mac: its ID is unknown here, and it never sees a sealed answer.
  const stranger = linkKeys(linkRoot(randomBytes(32).toString("base64url")));
  const other = reader(url, room, readKey, stranger);
  // Someone who copied this pairing's public ID off the network but has no key.
  const copied = reader(url, room, readKey, { ...stranger, id: keys.id, kid: keys.kid });
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const client of [other, copied]) {
    assert.ok(client.status === "connecting" || client.status === "reconnecting", client.status);
    assert.equal(client.synced, false);
    assert.equal(client.doc.getText("body").toString(), "");
  }
  // The phone's read-only key still cannot write, and the writer key is refused on the reader listener.
  const good = reader(url, room, readKey, keys);
  await good.whenSynced();
  good.doc.getText("body").insert(0, "phone edit ");
  const asWriter = reader(url, room, key, keys);
  await waitFor(() => asWriter.status === "denied", "the writer key to be refused");
  assert.equal(asWriter.reason, "wrong key");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(host.doc.getText("body").toString(), "secret pages");
});

test("a reader believes a sealed close code and no other", async () => {
  const { keys, relay, url } = await sealedListener();
  const { room, readKey } = relay.createRoom();
  const phone = reader(url, room, readKey, keys);
  await phone.whenSynced();
  relay.closeRoom(room);
  await waitFor(() => phone.status === "ended", "the sealed 4404");
  assert.equal(phone.reason, "room closed");

  const waiting = await sealedListener({ wait: true });
  const patient = reader(waiting.url, room, readKey, waiting.keys);
  await waitFor(() => patient.status === "reconnecting" && patient.reason === "no such room", "the sealed 4425");

  // A listener that says hello and then closes with "denied" in the clear, as someone on the network could.
  const forger = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  closers.push(() => new Promise<void>((resolve) => { for (const socket of forger.clients) socket.terminate(); forger.close(() => resolve()); }));
  let closes = 0;
  forger.on("connection", (socket) => {
    socket.send(hello(new Uint8Array(randomBytes(32))));
    socket.once("message", () => { closes++; socket.close(4401, "wrong key"); });
  });
  await new Promise((resolve) => forger.once("listening", resolve));
  const fooled = reader(`ws://127.0.0.1:${(forger.address() as AddressInfo).port}`, room, readKey, keys);
  await waitFor(() => closes >= 2, "the reader to try again after a forged close");
  assert.equal(fooled.status, "reconnecting");
});

test("a recorded handshake does not open a second connection", async () => {
  const { keys, relay, url } = await sealedListener();
  const { room, readKey, key } = relay.createRoom();
  const host = writer(relay, room, key);
  await host.whenSynced();
  host.doc.getText("body").insert(0, "pages");

  // Record everything the phone sends on a good connection.
  const recorded: Uint8Array[] = [];
  class Recording extends NodeSocket {
    override send(data: Uint8Array, ...rest: unknown[]) {
      recorded.push(new Uint8Array(data));
      return (super.send as (...args: unknown[]) => void)(data, ...rest);
    }
  }
  const phone = new RelayClient({ relay: url, room, key: readKey, doc: new Y.Doc(), readOnly: true,
    WebSocket: sealedWebSocket(keys, Recording as unknown as typeof WebSocket) });
  closers.push(() => phone.destroy());
  await phone.whenSynced();
  assert.ok(recorded.length >= 3);

  const replay = new NodeSocket(url + sealedPath(keys));
  const answers: Buffer[] = [];
  replay.on("message", (data) => {
    answers.push(data as Buffer);
    if (answers.length === 1) for (const frame of recorded) replay.send(frame);
  });
  const closed = await new Promise<number>((resolve) => replay.on("close", (code) => resolve(code)));
  assert.equal(answers.length, 1, "only the Mac's hello, which carries no script");
  assert.equal(closed, 1006);
});

test("a sealed reader is held to the relay's limits, and hears the refusal sealed", async () => {
  const { keys, relay, url } = await sealedListener({ limits: { maxConnections: 2, maxAwarenessBytes: 4096 } });
  const { room, key, readKey } = relay.createRoom();
  const host = writer(relay, room, key);
  await host.whenSynced();
  host.doc.getText("body").insert(0, "INT. LIGHTHOUSE - NIGHT");
  const first = reader(url, room, readKey, keys);
  await first.whenSynced();

  // The relay is full. A close code is believed only when it arrived sealed, so the reason reaching the client
  // shows the refusal went out through the tunnel; an unsealed close would read as a lost connection.
  const second = reader(url, room, readKey, keys);
  await waitFor(() => second.status === "reconnecting" && second.reason === "the relay is full", "the sealed refusal");
  assert.equal(relay.stats().connections, 2);
  first.destroy();
  await second.whenSynced();
  assert.equal(second.doc.getText("body").toString(), "INT. LIGHTHOUSE - NIGHT");

  // Presence past the limit closes the sealed reader like any other connection.
  second.awareness.setLocalState({ user: { name: "x".repeat(8192) } });
  await waitFor(() => second.status === "denied", "the oversized presence to be refused");
  assert.ok(![...host.awareness.getStates().values()].some((state) => String(state.user?.name).length > 4096));
});
