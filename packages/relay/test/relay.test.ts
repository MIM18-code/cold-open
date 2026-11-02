// The relay and client over real sockets on 127.0.0.1.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";
import { connect as tcpConnect } from "node:net";

import * as encoding from "lib0/encoding";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { RelayClient } from "../src/client.ts";
import { MESSAGE_AWARENESS, deriveReadKey, deriveRoom, formatInvite, parseInvite, randomId, roomUrl } from "../src/protocol.ts";
import { createRelay, readKeyFor, type Relay } from "../src/relay.ts";

const relays: Relay[] = [];
const clients: RelayClient[] = [];
after(async () => {
  for (const client of clients) client.destroy();
  for (const relay of relays) await relay.close();
});

async function startRelay(options: Parameters<typeof createRelay>[0] = {}): Promise<{ relay: Relay; url: string }> {
  const relay = await createRelay({ host: "127.0.0.1", port: 0, ...options });
  relays.push(relay);
  return { relay, url: `ws://127.0.0.1:${relay.port}` };
}

function connect(url: string, room: string, key: string, extra: { readOnly?: boolean; doc?: Y.Doc; awareness?: Awareness } = {}): RelayClient {
  const doc = extra.doc ?? new Y.Doc();
  const client = new RelayClient({ relay: url, room, key, doc, maxBackoff: 200, ...(extra.awareness ? { awareness: extra.awareness } : {}), ...(extra.readOnly ? { readOnly: true } : {}) });
  clients.push(client);
  return client;
}

async function waitFor(check: () => boolean, what: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A room name the way protocol.ts derives it, written out so the test pins the format. */
const roomOf = (key: string) => createHash("sha256").update("screenplay-room:" + key).digest().subarray(0, 16).toString("base64url");

const text = (client: RelayClient) => client.doc.getText("body").toString();

test("two writers converge", async () => {
  const { relay, url } = await startRelay();
  const { room, key } = relay.createRoom();
  const a = connect(url, room, key);
  const b = connect(url, room, key);
  await Promise.all([a.whenSynced(), b.whenSynced()]);
  a.doc.getText("body").insert(0, "INT. KITCHEN - DAY\n");
  b.doc.getText("body").insert(0, "FADE IN:\n");
  await waitFor(() => text(a) === text(b) && text(a).length === "INT. KITCHEN - DAY\nFADE IN:\n".length, "convergence");
  assert.ok(text(a).includes("FADE IN:") && text(a).includes("INT. KITCHEN"));
  assert.equal(a.status, "connected");
});

test("a late joiner gets the whole document, including edits made before anyone else connected", async () => {
  const { relay, url } = await startRelay();
  const { room, key } = relay.createRoom();
  const hostDoc = new Y.Doc();
  hostDoc.getText("body").insert(0, "Written before sharing.");
  const host = connect(url, room, key, { doc: hostDoc });
  await host.whenSynced();
  host.doc.getText("body").insert(0, "> ");
  await new Promise((resolve) => setTimeout(resolve, 50));
  host.destroy();
  const late = connect(url, room, key);
  await late.whenSynced();
  assert.equal(text(late), "> Written before sharing.");
});

test("remote changes use the client as origin, so a local UndoManager ignores them", async () => {
  const { relay, url } = await startRelay();
  const { room, key } = relay.createRoom();
  const local = Symbol("local");
  const a = connect(url, room, key);
  const b = connect(url, room, key);
  await Promise.all([a.whenSynced(), b.whenSynced()]);
  const undo = new Y.UndoManager(a.doc.getText("body"), { trackedOrigins: new Set([local, null]) });
  b.doc.getText("body").insert(0, "theirs");
  await waitFor(() => text(a) === "theirs", "remote text");
  assert.equal(undo.undoStack.length, 0);
  a.doc.transact(() => a.doc.getText("body").insert(0, "mine "), local);
  assert.equal(undo.undoStack.length, 1);
  undo.undo();
  assert.equal(text(a), "theirs");
});

test("a read-only key receives changes and presence, and the relay drops its edits", async () => {
  const { relay, url } = await startRelay();
  const { room, key, readKey } = relay.createRoom();
  assert.equal(readKey, await deriveReadKey(key));
  const writer = connect(url, room, key);
  await writer.whenSynced();
  writer.doc.getText("body").insert(0, "The script.");
  // A client that ignores its read-only key and sends edits anyway.
  const sneaky = connect(url, room, readKey);
  await sneaky.whenSynced();
  assert.equal(text(sneaky), "The script.");
  sneaky.doc.getText("body").insert(0, "VANDALISM ");
  sneaky.awareness.setLocalState({ user: { name: "Backlot" } });
  await waitFor(() => [...writer.awareness.getStates().values()].some((s) => s.user?.name === "Backlot"), "read-only presence");
  writer.doc.getText("body").insert(text(writer).length, " More.");
  await waitFor(() => text(sneaky).endsWith(" More."), "updates reach the read-only client");
  assert.equal(text(writer), "The script. More.");
  const late = connect(url, room, key);
  await late.whenSynced();
  assert.equal(text(late), "The script. More.");
});

test("a reader cannot rewrite or remove a writer's presence", async () => {
  const { relay, url } = await startRelay();
  const { room, key, readKey } = relay.createRoom();
  const writer = connect(url, room, key);
  const watcher = connect(url, room, key);
  await Promise.all([writer.whenSynced(), watcher.whenSynced()]);
  writer.awareness.setLocalState({ user: { name: "Ana", color: "#b5442c" } });
  await waitFor(() => watcher.awareness.getStates().get(writer.doc.clientID)?.user?.name === "Ana", "presence");
  // A raw reader sends an awareness update that claims the writer's client ID with a newer clock.
  const socket = new WebSocket(roomUrl(url, room, readKey));
  socket.binaryType = "arraybuffer";
  await new Promise((resolve) => (socket.onopen = resolve));
  for (const state of ['{"user":{"name":"Impostor","color":"#000000"}}', "null"]) {
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, writer.doc.clientID);
    encoding.writeVarUint(update, 1_000_000);
    encoding.writeVarString(update, state);
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
    socket.send(encoding.toUint8Array(message));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(watcher.awareness.getStates().get(writer.doc.clientID)?.user?.name, "Ana");
  socket.close();
});

test("a malformed connection URL is refused without crashing the relay", async () => {
  const { relay, url } = await startRelay();
  const crashes: unknown[] = [];
  const onCrash = (error: unknown) => crashes.push(error);
  process.on("uncaughtException", onCrash);
  try {
    for (const path of ["/%E0%A4%A?key=x", "//"]) {
      const reply = await new Promise<string>((resolve) => {
        const socket = tcpConnect(relay.port, "127.0.0.1", () => {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("close", () => resolve(data));
        setTimeout(() => socket.destroy(), 1000);
      });
      assert.match(reply, /^HTTP\/1\.1 101/);
    }
    assert.deepEqual(crashes, []);
    const { room, key } = relay.createRoom();
    await connect(url, room, key).whenSynced();
  } finally {
    process.off("uncaughtException", onCrash);
  }
});

test("a wrong key is refused and the client stops retrying", async () => {
  const { relay, url } = await startRelay();
  const { room } = relay.createRoom();
  const intruder = connect(url, room, randomId());
  await assert.rejects(intruder.whenSynced(), /wrong key/);
  assert.equal(intruder.status, "denied");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(intruder.status, "denied");
  assert.equal(relay.stats().connections, 0);
});

test("the hosted relay refuses unknown rooms; closing a room ends the session", async () => {
  const { relay, url } = await startRelay({ allowClaim: false });
  const stranger = connect(url, randomId(), randomId());
  await assert.rejects(stranger.whenSynced(), /no such room/);
  assert.equal(stranger.status, "ended");
  const { room, key } = relay.createRoom();
  const guest = connect(url, room, key);
  await guest.whenSynced();
  relay.closeRoom(room);
  await waitFor(() => guest.status === "ended", "session end");
});

test("when the hosted relay shuts down, its guests are told the session is over", async () => {
  const relay = await createRelay({ host: "127.0.0.1", port: 0, allowClaim: false });
  const { room, key } = relay.createRoom();
  const guest = connect(`ws://127.0.0.1:${relay.port}`, room, key);
  await guest.whenSynced();
  await relay.close();
  await waitFor(() => guest.status === "ended", "session end");
});

test("presence propagates and disappears when a writer leaves", async () => {
  const { relay, url } = await startRelay();
  const { room, key } = relay.createRoom();
  const a = connect(url, room, key);
  const b = connect(url, room, key);
  await Promise.all([a.whenSynced(), b.whenSynced()]);
  a.awareness.setLocalState({ user: { name: "Ana", color: "#b5442c" }, cursor: { anchor: { paragraphId: "p1", offset: 3 }, head: { paragraphId: "p1", offset: 3 } } });
  await waitFor(() => b.awareness.getStates().get(a.doc.clientID)?.user?.name === "Ana", "presence");
  assert.equal(b.awareness.getStates().get(a.doc.clientID)?.cursor.anchor.offset, 3);
  // A third writer joining later sees Ana at once.
  const c = connect(url, room, key);
  await c.whenSynced();
  await waitFor(() => c.awareness.getStates().get(a.doc.clientID)?.user?.name === "Ana", "presence for a late joiner");
  a.destroy();
  await waitFor(() => !b.awareness.getStates().has(a.doc.clientID), "presence removed");
});

test("the self-hosted relay lets a writer claim a room, and empty rooms expire", async () => {
  const { relay, url } = await startRelay({ allowClaim: true, emptyRoomTtl: 50 });
  const key = randomId();
  const room = roomOf(key);
  const a = connect(url, room, key);
  await a.whenSynced();
  a.doc.getText("body").insert(0, "claimed");
  assert.equal(relay.stats().rooms, 1);
  // The room now belongs to that key: a different key cannot take it over.
  const other = connect(url, room, randomId());
  await assert.rejects(other.whenSynced());
  a.destroy();
  await waitFor(() => relay.stats().rooms === 0, "room expiry");
});

test("a client reconnects after the relay restarts on the same port", async () => {
  const first = await startRelay({ allowClaim: true });
  const port = first.relay.port;
  const key = randomId();
  const room = roomOf(key);
  const a = connect(first.url, room, key);
  await a.whenSynced();
  a.doc.getText("body").insert(0, "survives");
  await first.relay.close();
  await waitFor(() => a.status === "reconnecting", "reconnecting");
  const second = await startRelay({ allowClaim: true, port });
  await waitFor(() => a.status === "connected", "reconnected", 5000);
  const b = connect(second.url, room, key);
  await b.whenSynced();
  assert.equal(text(b), "survives");
});

test("invites round-trip, and the Node and WebCrypto read keys agree", async () => {
  const room = randomId();
  const key = randomId();
  const lan = formatInvite({ relay: "ws://192.168.1.20:52144", room, key, readOnly: false });
  assert.match(lan, /^screenplay:\/\/join\?host=192\.168\.1\.20%3A52144&room=/);
  assert.deepEqual(parseInvite(lan), { relay: "ws://192.168.1.20:52144", room, key, readOnly: false });
  const hosted = formatInvite({ relay: "wss://relay.example.com", room, key: readKeyFor(key), readOnly: true });
  assert.deepEqual(parseInvite(`  ${hosted}\n`), { relay: "wss://relay.example.com", room, key: readKeyFor(key), readOnly: true });
  assert.throws(() => parseInvite("https://example.com"), /not a co-writing invite/);
  assert.throws(() => parseInvite("screenplay://join?host=1.2.3.4:5&room=short&key=x"), /incomplete/);
  assert.equal(await deriveReadKey(key), readKeyFor(key));
  assert.match(key, /^[A-Za-z0-9_-]{22}$/);
});

test("Tailscale ws invites round-trip without changing the invite format", () => {
  const invite = { relay: "ws://100.114.165.59:52144", room: randomId(), key: randomId(), readOnly: false };
  const text = formatInvite(invite);
  assert.match(text, /^screenplay:\/\/join\?host=100\.114\.165\.59%3A52144&room=/);
  assert.deepEqual(parseInvite(text), invite);
  const explicitRelay = new URL(text);
  explicitRelay.searchParams.delete("host");
  explicitRelay.searchParams.set("relay", invite.relay);
  assert.deepEqual(parseInvite(explicitRelay.href), invite);
});

test("the CLI starts a relay and answers health checks", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--port", "0", "--host", "127.0.0.1"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("listening")) resolve(output);
      });
      child.once("exit", (code) => reject(new Error(`CLI exited with ${code}`)));
    });
    const port = /:(\d+)/.exec(line)![1];
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), "screenplay-relay\n");
    const key = randomId();
    const a = connect(`ws://127.0.0.1:${port}`, roomOf(key), key);
    await a.whenSynced();
    a.destroy();
  } finally {
    child.kill("SIGTERM");
  }
});

test("a reader who reaches a restarted self-hosted relay first cannot claim the room or lock writers out", async () => {
  const first = await startRelay({ allowClaim: true });
  const port = first.relay.port;
  const key = randomId();
  const room = roomOf(key);
  const readKey = readKeyFor(key);
  const writer = connect(first.url, room, key);
  await writer.whenSynced();
  writer.doc.getText("body").insert(0, "The script.");
  writer.destroy();
  await first.relay.close();
  const second = await startRelay({ allowClaim: true, port });
  const reader = connect(second.url, room, readKey, { readOnly: true });
  await waitFor(() => reader.status === "reconnecting" && /not open/.test(reader.reason), "the reader is told to wait");
  assert.equal(second.relay.stats().rooms, 0);
  // The writer comes back and reopens the room with its own key; the reader then gets in, read-only.
  const back = connect(second.url, room, key);
  await back.whenSynced();
  back.doc.getText("body").insert(0, "Back. ");
  await waitFor(() => reader.status === "connected" && text(reader) === "Back. ", "the reader joins once the writer is back", 5000);
  // The reader's key still grants nothing more than reading.
  const sneaky = connect(second.url, room, readKey);
  await sneaky.whenSynced();
  sneaky.doc.getText("body").insert(0, "VANDALISM ");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(text(back), "Back. ");
});

test("a self-hosted room opens only for the read-write key its name is derived from", async () => {
  const { relay, url } = await startRelay({ allowClaim: true });
  const key = randomId();
  const stranger = connect(url, randomId(), key);
  await waitFor(() => stranger.status === "reconnecting" && /not open/.test(stranger.reason), "refusal");
  assert.equal(relay.stats().rooms, 0);
  assert.equal(await deriveRoom(key), roomOf(key));
  const hosted = relay.createRoom();
  assert.equal(hosted.room, roomOf(hosted.key));
});

test("a protocol error is terminal instead of replaying malformed messages forever", async () => {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  server.on("connection", socket => socket.close(4400, "malformed message"));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = connect(`ws://127.0.0.1:${address.port}`, randomId(), randomId());
  try {
    await assert.rejects(client.whenSynced(), /malformed message/);
    assert.equal(client.status, "denied");
  } finally {
    client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a remembered reader room can be restored with the same key and waits when its script is closed", async () => {
  const { createServer } = await import("node:http");
  const readerServer = createServer();
  await new Promise<void>(resolve => readerServer.listen(0, "127.0.0.1", resolve));
  const address = readerServer.address() as import("node:net").AddressInfo;
  const relay = await createRelay({ readerServer, readerWaitForRoom: true });
  let reader: WebSocket | undefined;
  try {
    const saved = relay.createRoom();
    relay.closeRoom(saved.room, 4425);
    const waitCode = new Promise<number>(resolve => {
      reader = new WebSocket(`ws://127.0.0.1:${address.port}/${saved.room}?key=${saved.readKey}`);
      reader.onclose = event => resolve(event.code);
    });
    assert.equal(await waitCode, 4425);
    assert.deepEqual(relay.createRoom(saved.key), saved);
    assert.throws(() => relay.createRoom(saved.key), /already exists/);
    assert.throws(() => relay.createRoom("bad"), /Invalid room key/);
  } finally {
    reader?.close(); await relay.close();
    await new Promise<void>(resolve => readerServer.close(() => resolve()));
  }
});
