// A client for the relay: keeps a Y.Doc and an awareness instance in step with a room over a WebSocket. Remote
// changes are applied with the client itself as the transaction origin, so an UndoManager that tracks only local
// origins never undoes another writer's typing. Runs in the browser, Electron's renderer and Node 22 (global WebSocket).
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as authProtocol from "y-protocols/auth";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

import {
  CLOSE_BAD_MESSAGE, CLOSE_DENIED, CLOSE_NOT_OPEN, CLOSE_NO_ROOM, MESSAGE_AUTH, MESSAGE_AWARENESS, MESSAGE_QUERY_AWARENESS, MESSAGE_SYNC, roomUrl,
} from "./protocol.ts";

/**
 * connecting: opening the socket. connected: open and in sync. reconnecting: lost, retrying with backoff.
 * denied: the relay refused the key. ended: the room is gone (the host stopped sharing). stopped: we left.
 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "denied" | "ended" | "stopped";

export interface RelayClientOptions {
  relay: string;
  room: string;
  key: string;
  doc: Y.Doc;
  awareness?: awarenessProtocol.Awareness;
  /** Do not send document changes (a read-only key; the relay would drop them anyway). */
  readOnly?: boolean;
  /** A WebSocket constructor, for runtimes without a global one. */
  WebSocket?: typeof WebSocket;
  /** Longest wait between reconnection attempts, in milliseconds. */
  maxBackoff?: number;
  /** Give up on a connection attempt that has not opened after this long, in milliseconds. */
  connectTimeout?: number;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

export class RelayClient {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly readOnly: boolean;
  status: ConnectionStatus = "connecting";
  /** The relay's copy of the document has reached us at least once since the last connect. */
  synced = false;
  /** Why the relay refused or ended the session, when it said. */
  reason = "";
  private readonly url: string;
  private readonly Socket: typeof WebSocket;
  private readonly maxBackoff: number;
  private readonly connectTimeout: number;
  private readonly ownsAwareness: boolean;
  private socket: WebSocket | null = null;
  private attempts = 0;
  private destroyed = false;
  /** The relay sent a permission-denied message; the close that follows must not reconnect. */
  private refused = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly syncListeners = new Set<() => void>();

  constructor(options: RelayClientOptions) {
    this.doc = options.doc;
    this.ownsAwareness = !options.awareness;
    this.awareness = options.awareness ?? new awarenessProtocol.Awareness(options.doc);
    this.readOnly = !!options.readOnly;
    this.url = roomUrl(options.relay, options.room, options.key);
    const Socket = options.WebSocket ?? globalThis.WebSocket;
    if (!Socket) throw new Error("This runtime has no WebSocket.");
    this.Socket = Socket;
    this.maxBackoff = options.maxBackoff ?? 30_000;
    this.connectTimeout = options.connectTimeout ?? 10_000;
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    this.connect();
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onSynced(listener: () => void): () => void {
    this.syncListeners.add(listener);
    return () => this.syncListeners.delete(listener);
  }

  /** Resolves once the relay's state has arrived, or rejects if the relay refuses us. */
  whenSynced(): Promise<void> {
    if (this.synced) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const offSync = this.onSynced(() => (offSync(), offStatus(), resolve()));
      const offStatus = this.onStatus((status) => {
        if (status === "denied" || status === "ended" || status === "stopped") {
          offSync();
          offStatus();
          reject(new Error(this.reason || `Connection ${status}.`));
        }
      });
    });
  }

  /** Leave: tell the others we are gone, close the socket and stop reconnecting. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.openTimer);
    // Sends our removal while the socket is still open, so other cursors vanish at once.
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close(1000, "left");
    }
    if (this.ownsAwareness) this.awareness.destroy();
    this.setStatus("stopped");
  }

  private connect(): void {
    if (this.destroyed) return;
    const socket = new this.Socket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.synced = false;
    this.openTimer = setTimeout(() => socket.close(), this.connectTimeout);
    socket.onopen = () => {
      if (this.destroyed || this.socket !== socket) return;
      clearTimeout(this.openTimer);
      this.attempts = 0;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
      if (this.awareness.getLocalState() !== null) this.sendAwareness([this.doc.clientID]);
    };
    socket.onmessage = (event) => {
      if (!this.destroyed && this.socket === socket) this.onMessage(new Uint8Array(event.data as ArrayBuffer));
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (!this.destroyed && this.socket === socket) this.onClose(event.code, event.reason);
    };
    this.setStatus(this.attempts ? "reconnecting" : "connecting");
  }

  private onClose(code: number, reason: string): void {
    clearTimeout(this.openTimer);
    this.socket = null;
    this.synced = false;
    // Everyone else's presence is stale once we lose the relay.
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (others.length) awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
    if (this.destroyed) return;
    if (code === CLOSE_NO_ROOM) {
      this.reason = reason || "The session has ended.";
      this.setStatus("ended");
      return;
    }
    if (code === CLOSE_NOT_OPEN) {
      // A reader of a self-hosted room that no writer has opened since the relay started: wait for one.
      this.refused = false;
      this.reason = reason || "Waiting for a writer to open the session.";
    } else if (this.refused || code === CLOSE_DENIED || code === CLOSE_BAD_MESSAGE) {
      this.reason ||= reason || "The relay refused the key.";
      this.setStatus("denied");
      return;
    }
    this.attempts++;
    const delay = Math.min(this.maxBackoff, 500 * 2 ** Math.min(this.attempts - 1, 10)) * (0.75 + Math.random() * 0.5);
    this.setStatus("reconnecting");
    if (!this.destroyed) this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const step = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      // Our reply to the relay's step 1 carries our state; a read-only client keeps it to itself.
      if (encoding.length(encoder) > 1 && !this.readOnly) this.send(encoding.toUint8Array(encoder));
      if (step === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        this.setStatus("connected");
        for (const listener of [...this.syncListeners]) listener();
      }
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    } else if (type === MESSAGE_AUTH) {
      authProtocol.readAuthMessage(decoder, this.doc, (_doc, reason) => {
        this.reason = reason;
        this.refused = true;
      });
    } else if (type === MESSAGE_QUERY_AWARENESS) {
      this.sendAwareness([...this.awareness.getStates().keys()]);
    }
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.readOnly) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  // Only our own presence goes out; the relay already has everyone else's.
  private readonly onAwarenessUpdate = ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
    if (origin !== "local") return;
    const changed = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
    if (changed.length) this.sendAwareness(changed);
  };

  private sendAwareness(clients: number[]): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.send(encoding.toUint8Array(encoder));
  }

  private send(message: Uint8Array): void {
    if (this.socket?.readyState === this.Socket.OPEN) this.socket.send(message);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }
}
