// The Mac's end of a sealed WebSocket (see sealed.ts). After the two hellos it looks to the relay like an ordinary
// socket: the relay's messages are encrypted on the way out and decrypted on the way in, and a close code is sent
// sealed first so the phone can believe it.
import { EventEmitter } from "node:events";
import type { RawData, WebSocket } from "ws";

import {
  FRAME_CLOSE, FRAME_DATA, FRAME_JOIN, Tunnel, closeFrame, hello, readHello, readJson, type LinkKeys,
} from "./sealed.ts";

function bytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

class SealedPeer extends EventEmitter {
  readonly OPEN = 1;
  private readonly raw: WebSocket;
  private readonly tunnel: Tunnel;
  constructor(raw: WebSocket, tunnel: Tunnel) { super(); this.raw = raw; this.tunnel = tunnel; }
  get readyState(): number { return this.raw.readyState; }
  /** Sealed bytes the phone has not read yet. The relay drops a peer that asks for more without reading. */
  get bufferedAmount(): number { return this.raw.bufferedAmount; }
  send(message: Uint8Array, done?: (error?: Error) => void): void {
    this.raw.send(this.tunnel.seal(FRAME_DATA, message), done);
  }
  close(code = 1000, reason = ""): void {
    if (this.raw.readyState === this.raw.OPEN) this.raw.send(this.tunnel.seal(FRAME_CLOSE, closeFrame(code, reason)));
    this.raw.close(code, reason);
  }
  ping(): void { this.raw.ping(); }
  terminate(): void { this.raw.terminate(); }
  receive(frame: Uint8Array): { type: number; payload: Uint8Array } { return this.tunnel.open(frame); }
}

/**
 * Run the sealed handshake on a new socket. `joined` gets a socket the relay can use as usual, plus the room and
 * key the phone asked for. A socket that does not finish the handshake in time, or sends anything that does not
 * authenticate, is dropped without a word.
 */
export function acceptSealed(raw: WebSocket, keys: LinkKeys, joined: (socket: WebSocket, room: string, key: string) => void,
    timeout = 10_000): void {
  const serverRandom = crypto.getRandomValues(new Uint8Array(32));
  let peer: SealedPeer | undefined, open = false;
  const timer = setTimeout(() => raw.terminate(), timeout);
  timer.unref?.();
  raw.on("message", (data) => {
    try {
      const frame = bytes(data);
      if (!peer) {
        peer = new SealedPeer(raw, new Tunnel(keys.root, readHello(frame), serverRandom, "mac"));
        return;
      }
      const { type, payload } = peer.receive(frame);
      if (!open) {
        const request = readJson(payload);
        if (type !== FRAME_JOIN || typeof request.room !== "string" || typeof request.key !== "string") throw new Error("join expected");
        open = true;
        clearTimeout(timer);
        joined(peer as unknown as WebSocket, request.room, request.key);
      } else if (type === FRAME_DATA) peer.emit("message", payload);
    } catch { raw.terminate(); }
  });
  raw.on("pong", () => peer?.emit("pong"));
  raw.on("error", () => raw.terminate());
  raw.on("close", (code, reason) => { clearTimeout(timer); peer?.emit("close", code, reason); });
  raw.send(hello(serverRandom));
}
