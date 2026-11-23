// Room, connection and document limits, over real sockets on 127.0.0.1.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as encoding from "lib0/encoding";
import * as authProtocol from "y-protocols/auth";
import * as Y from "yjs";

import { RelayClient } from "../src/client.ts";
import { MESSAGE_AUTH, MESSAGE_AWARENESS, randomId, roomUrl } from "../src/protocol.ts";
import { createRelay, type Relay } from "../src/relay.ts";

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

function connect(url: string, room: string, key: string, doc = new Y.Doc()): RelayClient {
  const client = new RelayClient({ relay: url, room, key, doc, maxBackoff: 200 });
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

const roomOf = (key: string) => createHash("sha256").update("screenplay-room:" + key).digest().subarray(0, 16).toString("base64url");
const text = (client: RelayClient) => client.doc.getText("body").toString();

/** Open a raw socket and report how the relay closed it. A socket still open after `wait` reports code 0. */
function closeOf(url: string, room: string, key: string, wait = 500): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(roomUrl(url, room, key));
    const timer = setTimeout(() => {
      socket.onclose = null;
      socket.close();
      resolve({ code: 0, reason: "stayed open" });
    }, wait);
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    };
  });
}

/**
 * A server that closes every connection the way the relay does: a refusal at connect sends an auth message first, a
 * writer stopped mid-session (4413) gets only the close.
 */
async function refusingServer(code: number, reason: string, auth = true) {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let attempts = 0;
  server.on("connection", (socket) => {
    attempts++;
    if (!auth) return socket.close(code, reason);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AUTH);
    authProtocol.writePermissionDenied(encoder, reason);
    socket.send(encoding.toUint8Array(encoder), () => socket.close(code, reason));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    attempts: () => attempts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A raw socket, open and ready to send. */
async function rawSocket(url: string, room: string, key: string): Promise<WebSocket> {
  const socket = new WebSocket(roomUrl(url, room, key));
  socket.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onclose = (event) => reject(new Error(`closed with ${event.code}`));
  });
  return socket;
}

/** Resolves with the close code once the relay closes the socket, or 0 if it is still open after `wait`. */
function closedWith(socket: WebSocket, wait = 1000): Promise<number> {
  if (socket.readyState === socket.CLOSED) return Promise.resolve(-1);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(0), wait);
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve(event.code);
    };
  });
}

/** An awareness message that sets one client's state. */
function presence(id: number, clock: number, state: string): Uint8Array {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, 1);
  encoding.writeVarUint(update, id);
  encoding.writeVarUint(update, clock);
  encoding.writeVarString(update, state);
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
  return encoding.toUint8Array(message);
}

/** The size of a document as the relay would encode it. */
const encodedSize = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc).length;

test("a claim past maxRooms is refused with 4429, creates nothing, and succeeds once a room expires", async () => {
  const { relay, url } = await startRelay({ allowClaim: true, maxRooms: 2, emptyRoomTtl: 50 });
  const first = randomId();
  const a = connect(url, roomOf(first), first);
  const second = randomId();
  const b = connect(url, roomOf(second), second);
  await Promise.all([a.whenSynced(), b.whenSynced()]);
  const third = randomId();
  const refused = await closeOf(url, roomOf(third), third);
  assert.deepEqual(refused, { code: 4429, reason: "the relay is full" });
  assert.equal(relay.stats().rooms, 2);
  a.destroy();
  await waitFor(() => relay.stats().rooms === 1, "the empty room to expire");
  await connect(url, roomOf(third), third).whenSynced();
  assert.equal(relay.stats().rooms, 2);
});

test("claimed and created rooms share maxRooms; createRoom past it throws", async () => {
  const { relay, url } = await startRelay({ allowClaim: true, maxRooms: 2 });
  const claimed = randomId();
  await connect(url, roomOf(claimed), claimed).whenSynced();
  const made = relay.createRoom();
  assert.throws(() => relay.createRoom(), /full/);
  const extra = randomId();
  assert.equal((await closeOf(url, roomOf(extra), extra)).code, 4429);
  assert.equal(relay.stats().rooms, 2);
  relay.closeRoom(made.room);
  relay.createRoom();
  assert.equal(relay.stats().rooms, 2);
});

test("a connection past maxConnections gets 4429 and is admitted after another leaves", async () => {
  const { relay, url } = await startRelay({ maxConnections: 2 });
  const { room, key } = relay.createRoom();
  const a = connect(url, room, key);
  const b = connect(url, room, key);
  await Promise.all([a.whenSynced(), b.whenSynced()]);
  assert.deepEqual(await closeOf(url, room, key), { code: 4429, reason: "the relay is full" });
  // A wrong key is still told it is wrong, not that the relay is full.
  assert.equal((await closeOf(url, room, randomId())).code, 4401);
  // The client keeps retrying while the relay is full and gets in once someone leaves.
  const c = connect(url, room, key);
  await waitFor(() => c.status === "reconnecting" && c.reason === "the relay is full", "the client to wait for space");
  assert.equal(relay.stats().connections, 2);
  a.destroy();
  await c.whenSynced();
  assert.equal(relay.stats().connections, 2);
});

test("a claim refused by maxConnections does not create the room", async () => {
  const { relay, url } = await startRelay({ allowClaim: true, maxConnections: 1 });
  const first = randomId();
  await connect(url, roomOf(first), first).whenSynced();
  const second = randomId();
  assert.equal((await closeOf(url, roomOf(second), second)).code, 4429);
  assert.equal(relay.stats().rooms, 1);
});

test("an update past maxDocBytes closes that writer with 4413 and leaves the room as it was", async () => {
  const { relay, url } = await startRelay({ maxDocBytes: 64 * 1024 });
  const { room, key } = relay.createRoom();
  const a = connect(url, room, key);
  const b = connect(url, room, key);
  await Promise.all([a.whenSynced(), b.whenSynced()]);
  b.doc.getText("body").insert(0, "FADE IN:");
  await waitFor(() => text(a) === "FADE IN:", "a small edit");
  a.doc.getText("body").insert(0, "x".repeat(100 * 1024));
  await waitFor(() => a.status === "denied", "the oversized writer to be stopped");
  assert.match(a.reason, /too large for this relay/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(a.status, "denied");
  assert.equal(b.status, "connected");
  assert.equal(text(b), "FADE IN:");
  b.doc.getText("body").insert(text(b).length, " INT. KITCHEN");
  const late = connect(url, room, key);
  await late.whenSynced();
  await waitFor(() => text(late) === "FADE IN: INT. KITCHEN", "the other writer's edit");
  assert.equal(relay.stats().connections, 2);
});

test("a message past maxPayload ends like 4413: the writer stops, the room keeps its document", async () => {
  const { relay, url } = await startRelay({ maxDocBytes: 64 * 1024, maxPayload: 96 * 1024 });
  const { room, key } = relay.createRoom();
  const b = connect(url, room, key);
  await b.whenSynced();
  b.doc.getText("body").insert(0, "FADE IN:");
  // The whole script goes out in the writer's first sync, one message larger than the relay accepts.
  const big = new Y.Doc();
  big.getText("body").insert(0, "x".repeat(200 * 1024));
  const a = connect(url, room, key, big);
  let retries = 0;
  a.onStatus((status) => {
    if (status === "reconnecting") retries++;
  });
  await waitFor(() => a.status === "denied" || retries > 0, "the oversized writer to stop or retry");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(retries, 0);
  assert.equal(a.status, "denied");
  assert.equal(a.reason, "the script is too large for this relay");
  assert.equal(b.status, "connected");
  b.doc.getText("body").insert(text(b).length, " INT. KITCHEN");
  const late = connect(url, room, key);
  await late.whenSynced();
  await waitFor(() => text(late) === "FADE IN: INT. KITCHEN", "the other writer's edit");
  assert.equal(relay.stats().connections, 2);
});

test("a document whose estimate overshoots is re-measured and accepted while its real size fits", async () => {
  const { relay, url } = await startRelay({ maxDocBytes: 32 * 1024 });
  const { room, key } = relay.createRoom();
  const a = connect(url, room, key);
  await a.whenSynced();
  const body = a.doc.getText("body");
  // Each pass sends about 4 KiB, so the running estimate passes the cap several times; deleted text is
  // garbage-collected, so the real document stays small.
  for (let pass = 0; pass < 40; pass++) {
    body.insert(0, String(pass % 10).repeat(4096));
    body.delete(0, body.length);
  }
  body.insert(0, "kept");
  const late = connect(url, room, key);
  await late.whenSynced();
  await waitFor(() => text(late) === "kept", "the final text");
  assert.equal(a.status, "connected");
});

test("deletions that split text cannot push a room far past maxDocBytes between measurements", async () => {
  const limit = 256 * 1024;
  const { relay, url } = await startRelay({ maxDocBytes: limit });
  const { room, key } = relay.createRoom();
  const a = connect(url, room, key);
  await a.whenSynced();
  const body = a.doc.getText("body");
  body.insert(0, "x".repeat(100_000));
  // Deleting every other character splits one item into many: each window's update is about 4 KB and grows the
  // encoded document by about 23 KB.
  for (let end = body.length; end > 0; end -= 2000) {
    a.doc.transact(() => {
      for (let i = end - 1; i >= Math.max(0, end - 2000); i -= 2) body.delete(i, 1);
    });
  }
  await waitFor(() => a.status === "denied", "the writer to reach the limit");
  const late = connect(url, room, key);
  await late.whenSynced();
  // Between measurements the relay accepts under a sixteenth of the limit in updates, and these add about 5.8 times
  // their size, so the most it allows is about 1.3 times the limit. This run measures 1.08.
  assert.ok(encodedSize(late.doc) <= 1.12 * limit, `${encodedSize(late.doc)} bytes against a limit of ${limit}`);
});

test("one large update cannot push a room past maxDocBytes", async () => {
  const limit = 256 * 1024;
  const { relay, url } = await startRelay({ maxDocBytes: limit });
  const { room, key } = relay.createRoom();
  const a = connect(url, room, key);
  await a.whenSynced();
  const body = a.doc.getText("body");
  body.insert(0, "x".repeat(60_000));
  // About 117 KB on the wire, well under the limit, but it grows the document by about 680 KB.
  a.doc.transact(() => {
    for (let i = body.length - 1; i >= 0; i -= 2) body.delete(i, 1);
  });
  await waitFor(() => a.status === "denied", "the oversized change to be refused");
  const late = connect(url, room, key);
  await late.whenSynced();
  assert.equal(text(late).length, 60_000);
  assert.ok(encodedSize(late.doc) <= limit);
});

test("an awareness update past maxAwarenessBytes closes the sender and reaches nobody", async () => {
  const { relay, url } = await startRelay({ maxAwarenessBytes: 1024 });
  const { room, key, readKey } = relay.createRoom();
  const watcher = connect(url, room, key);
  await watcher.whenSynced();
  const socket = await rawSocket(url, room, readKey);
  socket.send(presence(424242, 1, JSON.stringify({ user: { name: "x".repeat(2000) } })));
  assert.equal(await closedWith(socket), 4400);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(watcher.awareness.getStates().has(424242), false);
  assert.equal(watcher.status, "connected");
});

test("a connection that speaks for more than maxAwarenessClients IDs is closed and its presence removed", async () => {
  const { relay, url } = await startRelay({ maxAwarenessClients: 8 });
  const { room, key } = relay.createRoom();
  const watcher = connect(url, room, key);
  await watcher.whenSynced();
  const socket = await rawSocket(url, room, key);
  for (let id = 1; id <= 8; id++) socket.send(presence(id, 1, '{"user":{"name":"one of many"}}'));
  await waitFor(() => watcher.awareness.getStates().has(8), "eight presences");
  assert.equal(await closedWith(socket, 150), 0);
  socket.send(presence(9, 1, '{"user":{"name":"one too many"}}'));
  assert.equal(await closedWith(socket), 4400);
  await waitFor(() => [1, 2, 3, 4, 5, 6, 7, 8, 9].every((id) => !watcher.awareness.getStates().has(id)), "presence removed");
});

test("with maxAwarenessClients 1, a writer reconnecting takes over its own ID", async () => {
  const { relay, url } = await startRelay({ maxAwarenessClients: 1 });
  const { room, key } = relay.createRoom();
  const watcher = connect(url, room, key);
  await watcher.whenSynced();
  // The old connection has not timed out yet when the laptop wakes and reconnects with the same client ID.
  const stale = await rawSocket(url, room, key);
  stale.send(presence(77, 1, '{"user":{"name":"Ana"}}'));
  await waitFor(() => watcher.awareness.getStates().get(77)?.user?.name === "Ana", "presence");
  const fresh = await rawSocket(url, room, key);
  fresh.send(presence(77, 2, '{"user":{"name":"Ana again"}}'));
  await waitFor(() => watcher.awareness.getStates().get(77)?.user?.name === "Ana again", "the new connection's presence");
  // The stale connection gave up the ID, so it may now speak for another one.
  stale.send(presence(78, 1, '{"user":{"name":"Bea"}}'));
  await waitFor(() => watcher.awareness.getStates().get(78)?.user?.name === "Bea", "a second ID on the stale connection");
  assert.equal(await closedWith(fresh, 100), 0);
  assert.equal(await closedWith(stale, 100), 0);
  stale.close();
  fresh.close();
});

test("a null presence for a client the relay never saw leaves nothing behind", async () => {
  const { relay, url } = await startRelay();
  const { room, key } = relay.createRoom();
  const watcher = connect(url, room, key);
  await watcher.whenSynced();
  const socket = await rawSocket(url, room, key);
  // Removing an unknown client fires no change, but the relay used to keep its clock for as long as the room lived.
  socket.send(presence(500, 5, "null"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A later state with a lower clock is accepted only if that clock was not kept.
  socket.send(presence(500, 1, '{"user":{"name":"Ana"}}'));
  await waitFor(() => watcher.awareness.getStates().get(500)?.user?.name === "Ana", "the state to be accepted");
  socket.close();
});

test("presence IDs a connection sets and clears still count toward maxAwarenessClients, and are forgotten when it leaves", async () => {
  const { relay, url } = await startRelay({ maxAwarenessClients: 8 });
  const { room, key } = relay.createRoom();
  const watcher = connect(url, room, key);
  await watcher.whenSynced();
  const socket = await rawSocket(url, room, key);
  for (let id = 1; id <= 8; id++) {
    socket.send(presence(id, 1, '{"user":{"name":"brief"}}'));
    socket.send(presence(id, 2, "null"));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await closedWith(socket, 100), 0);
  socket.send(presence(9, 1, '{"user":{"name":"one too many"}}'));
  assert.equal(await closedWith(socket), 4400);
  await waitFor(() => relay.stats().connections === 1, "the closed connection to leave");
  // Clock 1 is older than the clock 2 the closed connection left behind, so the relay accepts it only if that was
  // dropped. The watcher kept clock 2 itself, so a client that joins afterwards checks.
  const next = await rawSocket(url, room, key);
  next.send(presence(1, 1, '{"user":{"name":"Bea"}}'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const late = connect(url, room, key);
  await late.whenSynced();
  await waitFor(() => late.awareness.getStates().get(1)?.user?.name === "Bea", "the reused ID");
  next.close();
});

test("a writer whose update Yjs cannot read is closed with 4400", async () => {
  const { relay, url } = await startRelay();
  const { room, key } = relay.createRoom();
  const socket = await rawSocket(url, room, key);
  // A sync update (0, 2) whose payload is one byte of a Yjs update that ends early.
  socket.send(new Uint8Array([0, 2, 1, 5]));
  assert.equal(await closedWith(socket), 4400);
});

test("sockets that never join a room are capped at the HTTP server too", async () => {
  const { relay, url } = await startRelay({ maxConnections: 2 });
  const { room, key } = relay.createRoom();
  const sockets: Socket[] = [];
  let dropped = 0;
  try {
    for (let i = 0; i < 200; i++) {
      const socket = tcpConnect(relay.port, "127.0.0.1");
      socket.on("error", () => undefined);
      socket.on("close", () => dropped++);
      sockets.push(socket);
    }
    await waitFor(() => dropped >= 100, "the server to refuse the extra sockets");
    assert.equal(relay.stats().connections, 0);
    for (const socket of sockets) socket.destroy();
    // Space comes back once they are gone.
    await waitFor(() => dropped === 200, "the sockets to close");
    await connect(url, room, key).whenSynced();
  } finally {
    for (const socket of sockets) socket.destroy();
  }
});

test("idle sockets that never send anything are closed by the relay and free their places", async () => {
  const { relay, url } = await startRelay({ maxConnections: 1, handshakeTimeout: 300 });
  const { room, key } = relay.createRoom();
  const sockets: Socket[] = [];
  let closed = 0;
  try {
    // More than the 1 + 64 sockets the server holds, none of which ever sends a byte or closes itself.
    for (let i = 0; i < 100; i++) {
      const socket = tcpConnect(relay.port, "127.0.0.1");
      socket.on("error", () => undefined);
      socket.on("close", () => closed++);
      sockets.push(socket);
    }
    await waitFor(() => closed === 100, "the relay to close every idle socket");
    const client = connect(url, room, key);
    await client.whenSynced();
    // A joined connection is not cut off by the timeout.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(client.status, "connected");
    assert.equal(relay.stats().connections, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
  }
});

test("a socket that trickles its request a byte at a time is still closed at the deadline", async () => {
  const handshakeTimeout = 400;
  const { relay } = await startRelay({ maxConnections: 1, handshakeTimeout });
  const request = Buffer.from(`GET /${"B".repeat(22)}?key=${"C".repeat(22)} HTTP/1.1\r\nHost: 127.0.0.1\r\n`);
  const started = Date.now();
  const socket = tcpConnect(relay.port, "127.0.0.1");
  socket.on("error", () => undefined);
  let sent = 0;
  const trickle = setInterval(() => {
    if (!socket.destroyed) socket.write(request.subarray(sent, ++sent));
  }, handshakeTimeout / 2);
  try {
    await new Promise((resolve) => socket.once("close", resolve));
    const lasted = Date.now() - started;
    // An idle timer would keep it until Node's own headers timeout, a minute or more.
    assert.ok(lasted < 3 * handshakeTimeout, `closed after ${lasted} ms`);
    assert.ok(sent >= 1, "the socket sent bytes before the deadline");
  } finally {
    clearInterval(trickle);
    socket.destroy();
  }
});

test("RelayClient stops on 4413 instead of resending the same script", async () => {
  const server = await refusingServer(4413, "the script is too large for this relay", false);
  const client = connect(server.url, randomId(), randomId());
  try {
    await waitFor(() => client.status === "denied", "the client to stop", 2000);
    assert.match(client.reason, /too large for this relay/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(server.attempts(), 1);
  } finally {
    client.destroy();
    await server.close();
  }
});

test("RelayClient keeps retrying with backoff on 4429", async () => {
  const server = await refusingServer(4429, "the relay is full");
  const client = connect(server.url, randomId(), randomId());
  try {
    await waitFor(() => server.attempts() >= 3, "several attempts");
    assert.equal(client.status, "reconnecting");
    assert.equal(client.reason, "the relay is full");
  } finally {
    client.destroy();
    await server.close();
  }
});

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the CLI documents the limit flags and rejects bad values", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  for (const flag of ["--max-rooms", "--max-connections", "--max-doc-mb"]) assert.ok(help.stdout.includes(flag), flag);
  for (const bad of [["--max-rooms", "-1"], ["--max-connections", "1.5"], ["--max-doc-mb", "lots"]]) {
    const result = await run([...bad, "--port", "0", "--host", "127.0.0.1"]);
    assert.notEqual(result.code, 0, bad.join(" "));
  }
});

test("the CLI enforces --max-rooms and states the limits at startup", async () => {
  const child = spawn(process.execPath, [cli, "--port", "0", "--host", "127.0.0.1", "--max-rooms", "1", "--max-doc-mb", "0"],
    { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("listening")) resolve(output);
      });
      child.once("exit", (code) => reject(new Error(`CLI exited with ${code}`)));
    });
    assert.match(line, /1 room/);
    assert.match(line, /100 connections/);
    assert.match(line, /no document limit/);
    const url = `ws://127.0.0.1:${/:(\d+)/.exec(line)![1]}`;
    const first = randomId();
    await connect(url, roomOf(first), first).whenSynced();
    const second = randomId();
    assert.equal((await closeOf(url, roomOf(second), second)).code, 4429);
    // The CLI caps presence at 8 client IDs per connection.
    const socket = await rawSocket(url, roomOf(first), first);
    for (let id = 1; id <= 9; id++) socket.send(presence(id, 1, "{}"));
    assert.equal(await closedWith(socket), 4400);
  } finally {
    child.kill("SIGTERM");
  }
});
