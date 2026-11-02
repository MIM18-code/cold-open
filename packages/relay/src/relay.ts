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
  CLOSE_BAD_MESSAGE, CLOSE_DENIED, CLOSE_NOT_OPEN, CLOSE_NO_ROOM, ID_PATTERN, MESSAGE_AUTH, MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS, MESSAGE_SYNC, READ_KEY_PREFIX, ROOM_PREFIX, base64url, randomId,
} from "./protocol.ts";

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
  /** Also serve readers on an existing HTTP(S) listener, e.g. the paired phone server. */
  readerServer?: ReturnType<typeof createServer>;
  /** A remembered phone waits for its script to reopen. */
  readerWaitForRoom?: boolean;
  /** Interval for WebSocket pings that drop dead connections, in milliseconds. */
  pingInterval?: number;
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
  /** Awareness client IDs this connection speaks for, removed when it disconnects. */
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
        for (const id of removed) connection.clients.delete(id);
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

function send(socket: WebSocket, message: Uint8Array): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(message, (error) => {
    if (error) socket.terminate();
  });
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

  const removeRoom = (room: Room, code?: number) => {
    if (rooms.get(room.name) !== room) return;
    rooms.delete(room.name);
    room.destroy(code);
    log(`room closed (${rooms.size} open)`);
  };

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
    socket.on("error", () => socket.terminate());

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
    if (!room.connections.size && !room.pinned) {
      room.expiry = setTimeout(() => removeRoom(room), ttl);
      room.expiry.unref?.();
    }
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
          send(connection.socket, encoding.toUint8Array(encoder));
        } else if (step === syncProtocol.messageYjsSyncStep2 || step === syncProtocol.messageYjsUpdate) {
          // Read-only clients never change the document.
          if (connection.access === "write") syncProtocol.readUpdate(decoder, room.doc, connection);
        } else throw new Error("unknown sync message");
      } else if (type === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        // A reader speaks only for its own clients, so it cannot rewrite or remove a writer's presence. A writer may
        // take over its own ID from a connection that has not yet timed out (a laptop waking up and reconnecting).
        if (connection.access === "read" && awarenessClients(update).some((id) => ownedElsewhere(room, id, connection))) return;
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, connection);
      } else if (type === MESSAGE_QUERY_AWARENESS) {
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
        send(connection.socket, encoding.toUint8Array(encoder));
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
    wss.handleUpgrade(request, stream, head, (socket) => {
      if (!ID_PATTERN.test(name) || !ID_PATTERN.test(key)) return deny(socket, CLOSE_DENIED, "invalid room or key");
      let room = rooms.get(name);
      if (!room) {
        if (readersOnly || !options.allowClaim) return deny(socket,
          readersOnly && options.readerWaitForRoom ? CLOSE_NOT_OPEN : CLOSE_NO_ROOM, "no such room");
        // Only the read-write key the name was derived from opens a room. Anything else (a read-only key after a
        // restart or expiry) must not become the room's key, or a reader would gain write access and lock writers out.
        if (!sameKey(roomFor(key), name)) return deny(socket, CLOSE_NOT_OPEN, "the room is not open yet");
        room = new Room(name, readKeyFor(key), false);
        rooms.set(name, room);
        log(`room opened (${rooms.size} open)`);
      }
      const access = room.accessFor(key);
      if (!access || (readersOnly && access !== "read")) return deny(socket, CLOSE_DENIED, "wrong key");
      join(room, socket, access);
    });
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
      const keys = { room: roomFor(key), key, readKey: readKeyFor(key) };
      rooms.set(keys.room, new Room(keys.room, keys.readKey, true));
      return keys;
    },
    closeRoom(name, code = CLOSE_NO_ROOM) {
      const room = rooms.get(name);
      if (room) removeRoom(room, code);
    },
    stats() {
      let connections = 0;
      for (const room of rooms.values()) connections += room.connections.size;
      return { rooms: rooms.size, connections };
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
