// The relay server: rooms of Yjs documents over WebSockets, speaking the y-websocket protocol. Each room keeps
// its own Y.Doc so a writer who joins late gets the whole script, and an awareness instance for presence.
// A room key grants read-write access; the room's read-only key lets a client follow along (Backlot), and the
// relay drops any document change it sends. A room's name is derived from its read-write key, so only a writer can
// open a room on a self-hosted relay; a reader who arrives first waits for one.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as authProtocol from "y-protocols/auth";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import * as Y from "yjs";

import {
  CLOSE_BAD_MESSAGE, CLOSE_DENIED, CLOSE_FULL, CLOSE_NOT_OPEN, CLOSE_NO_ROOM, CLOSE_TOO_LARGE, ID_PATTERN, MESSAGE_AUTH, MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS, MESSAGE_SYNC, READ_KEY_PREFIX, ROOM_PREFIX, base64url, randomId,
} from "./protocol.ts";
import type { LinkKeys } from "./sealed.ts";
import { acceptSealed } from "./sealed-peer.ts";

export interface RelayOptions {
  /** 0 picks a free port. */
  port?: number;
  /** "0.0.0.0" for the LAN, "127.0.0.1" for this machine only. */
  host?: string;
  /**
   * Let a client create a room by connecting to an unknown room name with the read-write key that name is derived
   * from (roomFor). This is the self-hosted relay.
   * When false, only rooms made with createRoom() exist (the relay a desktop app hosts).
   */
  allowClaim?: boolean;
  /** How long an empty claimed room keeps its document before it is dropped, in milliseconds. */
  emptyRoomTtl?: number;
  /** Largest message accepted, in bytes. */
  maxPayload?: number;
  /** Rooms open at once, claimed and created together. Undefined means no limit. */
  maxRooms?: number;
  /** Joined connections across every room. Undefined means no limit. */
  maxConnections?: number;
  /** Largest document a room may hold, as encoded Yjs state in bytes. Undefined means no limit. */
  maxDocBytes?: number;
  /** Largest awareness (presence) update accepted, in bytes. Undefined means no limit. */
  maxAwarenessBytes?: number;
  /** Awareness client IDs one connection may speak for. A real client has one. Undefined means no limit. */
  maxAwarenessClients?: number;
  /** Also serve readers on an existing HTTP(S) listener, e.g. the paired phone server. */
  readerServer?: ReturnType<typeof createServer>;
  /** A remembered phone waits for its script to reopen. */
  readerWaitForRoom?: boolean;
  /**
   * Make the reader listener accept only sealed connections (sealed.ts): a phone on plain ws:// whose pairing
   * secret came from a QR code. Returns the keys for a pairing ID, or nothing for an unknown one.
   */
  readerSealed?: (id: string) => LinkKeys | undefined;
  /** Interval for WebSocket pings that drop dead connections, in milliseconds. */
  pingInterval?: number;
  /** How long a socket on the relay's own port may sit idle before it asks to join, in milliseconds. For tests. */
  handshakeTimeout?: number;
  /** Receives counts and errors. Never room keys. */
  log?: (message: string) => void;
}

export interface RoomKeys {
  room: string;
  /** Read-write key. */
  key: string;
  /** Read-only key. */
  readKey: string;
}

export interface Relay {
  readonly port: number;
  readonly host: string;
  /** Make a room that lasts until closeRoom() or close(), and return its keys. */
  createRoom(key?: string): RoomKeys;
  /** Disconnect everyone in a room and forget its document. */
  closeRoom(room: string, code?: number): void;
  stats(): { rooms: number; connections: number };
  close(): Promise<void>;
}

type Access = "write" | "read";

interface Connection {
  socket: WebSocket;
  access: Access;
  /**
   * Awareness client IDs this connection speaks for, removed when it disconnects. An ID it clears stays here: the
   * relay keeps that client's clock, so it still counts toward maxAwarenessClients.
   */
  clients: Set<number>;
  alive: boolean;
}

function hashId(prefix: string, key: string): string {
  return base64url(createHash("sha256").update(prefix + key).digest().subarray(0, 16));
}

/** The read-only key for a read-write key. Matches deriveReadKey() in protocol.ts. */
export function readKeyFor(key: string): string {
  return hashId(READ_KEY_PREFIX, key);
}

/** The room name for a read-write key. Matches deriveRoom() in protocol.ts. */
export function roomFor(key: string): string {
  return hashId(ROOM_PREFIX, key);
}

function sameKey(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly connections = new Map<WebSocket, Connection>();
  expiry: ReturnType<typeof setTimeout> | undefined;
  readonly name: string;
  readonly readKey: string;
  /** Made by createRoom(): never expires on its own. */
  readonly pinned: boolean;
  /** The encoded document size at the last measurement. */
  measured = 0;
  /**
   * Bytes of updates accepted since then. measured + since estimates the size; it can run low, because an update that
   * deletes scattered characters splits text into many items and grows the document several times its own length.
   */
  since = 0;

  constructor(name: string, readKey: string, pinned: boolean) {
    this.name = name;
    this.readKey = readKey;
    this.pinned = pinned;
    // The relay is not a participant, so it has no presence of its own.
    this.awareness.setLocalState(null);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const connection of this.connections.values()) if (connection !== origin) send(connection.socket, message);
    });
    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const connection = origin as Connection | undefined;
      if (connection && this.connections.get(connection.socket) === connection) {
        for (const id of [...added, ...updated]) {
          connection.clients.add(id);
          // When a stale connection for this client closes later, it must not remove the live presence.
          for (const other of this.connections.values()) if (other !== connection) other.clients.delete(id);
        }
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const message = encoding.toUint8Array(encoder);
      for (const other of this.connections.values()) send(other.socket, message);
    });
  }

  /** Which access a key grants, or null for a wrong key. */
  accessFor(key: string): Access | null {
    if (sameKey(readKeyFor(key), this.readKey)) return "write";
    if (sameKey(key, this.readKey)) return "read";
    return null;
  }

  /** CLOSE_NO_ROOM tells clients the session is over; 1001 (going away) lets them reconnect to a restarted relay. */
  destroy(code = CLOSE_NO_ROOM): void {
    clearTimeout(this.expiry);
    for (const connection of this.connections.values()) connection.socket.close(code, code === CLOSE_NO_ROOM ? "room closed" : "relay stopped");
    this.connections.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

/** How much unread data a peer may have waiting and still be answered. */
const MAX_UNREAD = 16 * 1024 * 1024;

/** The largest answer sent to each peer by reply(), which may sit unread on top of MAX_UNREAD. */
const answered = new WeakMap<WebSocket, number>();

/**
 * Relay a message. A peer that stops reading while the room keeps talking (its own presence is echoed back to it)
 * would grow the host's memory without limit, so it is dropped once it has MAX_UNREAD unread beyond its largest
 * answer. A reader still receiving a large script is kept.
 */
function send(socket: WebSocket, message: Uint8Array): void {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > MAX_UNREAD + (answered.get(socket) ?? 0)) return socket.terminate();
  socket.send(message, (error) => {
    if (error) socket.terminate();
  });
}

/**
 * Drop a socket on any error but one. For a message past maxPayload, ws has already sent close code 1009 and stops
 * reading (incoming data is discarded), so terminating would only risk losing that close frame, and the client would
 * reconnect and resend the same script forever. ws destroys the socket itself if the peer has not closed in 30 seconds.
 */
function dropOnError(socket: WebSocket): (error: Error & { code?: string }) => void {
  return (error) => {
    if (error.code !== "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") socket.terminate();
  };
}

/**
 * Answer a peer's own request (the document, everyone's presence). A peer that keeps asking without reading the
 * answers would grow the host's memory without limit, so it is dropped and may reconnect. One answer of any size
 * still goes out, and send() lets relayed messages queue behind it.
 */
function reply(socket: WebSocket, message: Uint8Array): void {
  if (socket.bufferedAmount > MAX_UNREAD) return socket.terminate();
  answered.set(socket, Math.max(answered.get(socket) ?? 0, message.length));
  send(socket, message);
}

/** The client IDs an awareness update speaks for. */
function awarenessClients(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const ids: number[] = [];
  const count = decoding.readVarUint(decoder);
  for (let i = 0; i < count; i++) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return ids;
}

/** Whether a client ID belongs to a connection other than this one. */
function ownedElsewhere(room: Room, id: number, connection: Connection): boolean {
  for (const other of room.connections.values()) if (other !== connection && other.clients.has(id)) return true;
  return false;
}

/** Sockets the HTTP server holds beyond maxConnections, for peers still joining or being refused. */
const HANDSHAKE_ROOM = 64;

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export async function createRelay(options: RelayOptions = {}): Promise<Relay> {
  const host = options.host ?? "127.0.0.1";
  const ttl = options.emptyRoomTtl ?? 10 * 60_000;
  const log = options.log ?? (() => undefined);
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload ?? 32 * 1024 * 1024 });

  const server = createServer((request, response) => {
    // A plain GET answers health checks; everything else is a WebSocket upgrade.
    response.writeHead(request.url === "/" ? 200 : 404, { "content-type": "text/plain" });
    response.end(request.url === "/" ? "screenplay-relay\n" : "not found\n");
  });
  // maxConnections counts only joined connections, so sockets that never finish joining (idle, refused, or still in
  // the handshake) are capped here, with room for handshakes in progress.
  if (options.maxConnections !== undefined) server.maxConnections = options.maxConnections + HANDSHAKE_ROOM;
  // Node never closes a socket that sends nothing, and one that trickles a byte at a time lasts until its headers
  // timeout, so such sockets could hold those places and lock everyone out. Each socket gets a fixed deadline from
  // accept, not an idle timer, cleared once it asks to join; joined connections have the ping check.
  const handshakeTimeout = options.handshakeTimeout ?? 10_000;
  const deadlines = new WeakMap<Duplex, ReturnType<typeof setTimeout>>();
  server.on("connection", (socket) => {
    const deadline = setTimeout(() => socket.destroy(), handshakeTimeout);
    deadline.unref();
    deadlines.set(socket, deadline);
    socket.once("close", () => clearTimeout(deadline));
  });

  const removeRoom = (room: Room, code?: number) => {
    if (rooms.get(room.name) !== room) return;
    rooms.delete(room.name);
    room.destroy(code);
    log(`room closed (${rooms.size} open)`);
  };

  const connectionCount = () => {
    let count = 0;
    for (const room of rooms.values()) count += room.connections.size;
    return count;
  };
  const roomsFull = () => options.maxRooms !== undefined && rooms.size >= options.maxRooms;
  const connectionsFull = () => options.maxConnections !== undefined && connectionCount() >= options.maxConnections;

  const deny = (socket: WebSocket, code: number, reason: string) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AUTH);
    authProtocol.writePermissionDenied(encoder, reason);
    socket.send(encoding.toUint8Array(encoder), () => socket.close(code, reason));
  };

  const join = (room: Room, socket: WebSocket, access: Access) => {
    clearTimeout(room.expiry);
    const connection: Connection = { socket, access, clients: new Set(), alive: true };
    room.connections.set(socket, connection);
    socket.on("pong", () => (connection.alive = true));
    socket.on("message", (data) => handleMessage(room, connection, toBytes(data)));
    socket.on("close", () => leave(room, connection));

    // Server side of the handshake: our state vector, then everyone's presence.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(socket, encoding.toUint8Array(encoder));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) {
      const awareness = encoding.createEncoder();
      encoding.writeVarUint(awareness, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(awareness, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states));
      send(socket, encoding.toUint8Array(awareness));
    }
  };

  const leave = (room: Room, connection: Connection) => {
    if (room.connections.get(connection.socket) !== connection) return;
    room.connections.delete(connection.socket);
    if (connection.clients.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...connection.clients], null);
    // Awareness keeps a removed client's clock until the room closes; drop the ones this connection leaves behind.
    for (const id of connection.clients) if (!room.awareness.states.has(id)) room.awareness.meta.delete(id);
    if (!room.connections.size && !room.pinned) {
      room.expiry = setTimeout(() => removeRoom(room), ttl);
      room.expiry.unref?.();
    }
  };

  /**
   * Whether an update keeps the room's document within maxDocBytes, counting it as accepted if so. Yjs cannot roll an
   * update back, so decide first. Measuring is O(document), so it runs once per sixteenth of the limit in input; the
   * updates accepted in between can take the document past the limit by what they add, about a third of it at most.
   */
  const accepts = (room: Room, update: Uint8Array): boolean => {
    const limit = options.maxDocBytes;
    if (limit === undefined) return true;
    const n = update.length;
    if (n >= limit / 16) {
      // One update this large could add several times the limit, so try it on a copy. Its own size pays for that.
      const copy = new Y.Doc();
      let size: number;
      try {
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(room.doc));
        Y.applyUpdate(copy, update);
        size = Y.encodeStateAsUpdate(copy).length;
      } finally {
        copy.destroy();
      }
      if (size > limit) return false;
      room.measured = size;
      room.since = 0;
      return true;
    }
    if (room.since + n >= limit / 16) {
      room.measured = Y.encodeStateAsUpdate(room.doc).length;
      room.since = 0;
    }
    if (room.measured + room.since + n > limit) return false;
    room.since += n;
    return true;
  };

  // syncProtocol.readUpdate, with the payload length checked before it is applied. An update Yjs cannot read closes
  // the writer like any other malformed message.
  const applyUpdate = (room: Room, connection: Connection, decoder: decoding.Decoder) => {
    try {
      const update = decoding.readVarUint8Array(decoder);
      if (!accepts(room, update)) {
        log("refused an update past the document limit");
        connection.socket.close(CLOSE_TOO_LARGE, "the script is too large for this relay");
        return;
      }
      Y.applyUpdate(room.doc, update, connection);
    } catch (error) {
      log(`dropped an update Yjs could not read: ${error instanceof Error ? error.message : String(error)}`);
      connection.socket.close(CLOSE_BAD_MESSAGE, "malformed message");
    }
  };

  const awarenessFits = (connection: Connection, update: Uint8Array): boolean => {
    if (options.maxAwarenessBytes !== undefined && update.length > options.maxAwarenessBytes) return false;
    if (options.maxAwarenessClients === undefined) return true;
    const added = new Set(awarenessClients(update).filter((id) => !connection.clients.has(id)));
    return connection.clients.size + added.size <= options.maxAwarenessClients;
  };

  const handleMessage = (room: Room, connection: Connection, data: Uint8Array) => {
    try {
      const decoder = decoding.createDecoder(data);
      const encoder = encoding.createEncoder();
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const step = decoding.readVarUint(decoder);
        if (step === syncProtocol.messageYjsSyncStep1) {
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncStep1(decoder, encoder, room.doc);
          reply(connection.socket, encoding.toUint8Array(encoder));
        } else if (step === syncProtocol.messageYjsSyncStep2 || step === syncProtocol.messageYjsUpdate) {
          // Read-only clients never change the document. Nor does a writer the relay is closing: its later edits may
          // depend on the one it refused, and Yjs would hold them as pending.
          if (connection.access === "write" && connection.socket.readyState === connection.socket.OPEN) applyUpdate(room, connection, decoder);
        } else throw new Error("unknown sync message");
      } else if (type === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        // The relay keeps every state it is sent until the connection closes, so presence gets limits of its own.
        if (!awarenessFits(connection, update)) {
          connection.socket.close(CLOSE_BAD_MESSAGE, "presence over the relay's limit");
          return;
        }
        // A reader speaks only for its own clients, so it cannot rewrite or remove a writer's presence. A writer may
        // take over its own ID from a connection that has not yet timed out (a laptop waking up and reconnecting).
        const ids = awarenessClients(update);
        if (connection.access === "read" && ids.some((id) => ownedElsewhere(room, id, connection))) return;
        const unknown = ids.filter((id) => !room.awareness.meta.has(id));
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, connection);
        // Clearing a client the relay never saw changes nothing anyone can see, but Awareness would keep its clock
        // until the room closes, so a stream of fresh IDs would grow the host's memory without limit.
        for (const id of unknown) if (!room.awareness.states.has(id)) room.awareness.meta.delete(id);
      } else if (type === MESSAGE_QUERY_AWARENESS) {
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
        reply(connection.socket, encoding.toUint8Array(encoder));
      }
      // Other message types (auth from a client, future extensions) are ignored.
    } catch (error) {
      log(`dropped a malformed message: ${error instanceof Error ? error.message : String(error)}`);
      connection.socket.close(CLOSE_BAD_MESSAGE, "malformed message");
    }
  };

  const onUpgrade = (request: IncomingMessage, stream: Duplex, head: Buffer, readersOnly = false) => {
    // Anyone on the network can reach this; a malformed URL must not throw out of the server.
    let name = "";
    let key = "";
    try {
      const url = new URL(request.url ?? "/", "ws://relay");
      name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      key = url.searchParams.get("key") ?? "";
    } catch {
      // Left empty, the room and key fail validation below and the client is refused.
    }
    // The reader listener belongs to the phone server, which sets its own socket rules.
    if (!readersOnly) clearTimeout(deadlines.get(stream));
    wss.handleUpgrade(request, stream, head, (socket) => {
      // Before any refusal: a refused peer can still send a broken frame, and a WebSocket "error" with no listener
      // is an uncaught exception in the app that hosts this relay.
      socket.on("error", dropOnError(socket));
      if (readersOnly && options.readerSealed) {
        // The room and key arrive inside the tunnel, so neither is ever in a URL on the network.
        const keys = /^sealed\/[A-Za-z0-9_-]{22}$/.test(name) ? options.readerSealed(name.slice(7)) : undefined;
        if (!keys) return deny(socket, CLOSE_DENIED, "unknown pairing");
        return acceptSealed(socket, keys, (sealed, room, roomKey) => admit(sealed, room, roomKey, true));
      }
      admit(socket, name, key, readersOnly);
    });
  };

  const admit = (socket: WebSocket, name: string, key: string, readersOnly: boolean) => {
    if (!ID_PATTERN.test(name) || !ID_PATTERN.test(key)) return deny(socket, CLOSE_DENIED, "invalid room or key");
    let room = rooms.get(name);
    if (!room) {
      if (readersOnly || !options.allowClaim) return deny(socket,
        readersOnly && options.readerWaitForRoom ? CLOSE_NOT_OPEN : CLOSE_NO_ROOM, "no such room");
      // Only the read-write key the name was derived from opens a room. Anything else (a read-only key after a
      // restart or expiry) must not become the room's key, or a reader would gain write access and lock writers out.
      if (!sameKey(roomFor(key), name)) return deny(socket, CLOSE_NOT_OPEN, "the room is not open yet");
      if (roomsFull() || connectionsFull()) return deny(socket, CLOSE_FULL, "the relay is full");
      room = new Room(name, readKeyFor(key), false);
      rooms.set(name, room);
      log(`room opened (${rooms.size} open)`);
    }
    const access = room.accessFor(key);
    if (!access || (readersOnly && access !== "read")) return deny(socket, CLOSE_DENIED, "wrong key");
    if (connectionsFull()) return deny(socket, CLOSE_FULL, "the relay is full");
    join(room, socket, access);
  };
  server.on("upgrade", onUpgrade);
  const readerUpgrade = (request: IncomingMessage, stream: Duplex, head: Buffer) =>
    onUpgrade(request, stream, head, true);
  options.readerServer?.on("upgrade", readerUpgrade);

  // Drop connections that stopped answering pings (a laptop lid closed mid-session).
  const pinger = setInterval(() => {
    for (const room of rooms.values()) {
      for (const connection of room.connections.values()) {
        if (!connection.alive) {
          connection.socket.terminate();
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
      }
    }
  }, options.pingInterval ?? 30_000);
  pinger.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    host,
    createRoom(key = randomId()) {
      if (!ID_PATTERN.test(key)) throw new Error("Invalid room key.");
      if (rooms.has(roomFor(key))) throw new Error("Room already exists.");
      if (roomsFull()) throw new Error(`The relay is full: it already has ${options.maxRooms} rooms open.`);
      const keys = { room: roomFor(key), key, readKey: readKeyFor(key) };
      rooms.set(keys.room, new Room(keys.room, keys.readKey, true));
      return keys;
    },
    closeRoom(name, code = CLOSE_NO_ROOM) {
      const room = rooms.get(name);
      if (room) removeRoom(room, code);
    },
    stats() {
      return { rooms: rooms.size, connections: connectionCount() };
    },
    async close() {
      options.readerServer?.off("upgrade", readerUpgrade);
      clearInterval(pinger);
      // A claimed room can be rebuilt by its writers when a restarted relay comes back, so they reconnect (1001).
      // The hosted relay's rooms die with it, so its guests are told the session is over.
      for (const room of [...rooms.values()]) removeRoom(room, options.allowClaim ? 1001 : CLOSE_NO_ROOM);
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
