// The sealed link: how a paired phone and the Mac talk over plain http:// and ws:// on home Wi-Fi so that nobody
// else on the network can read or change the traffic, and no certificate is involved. Both ends hold a 256-bit
// secret that travelled in the pairing QR code, never over the network. Every HTTP body and every WebSocket
// message is encrypted and authenticated with AES-256-GCM under keys derived from that secret with HKDF-SHA256. The secret itself, and the room key, are never sent. docs/sync-protocol.md describes the wire
// format.
//
// This file imports no crypto library and no Node API. The primitives come from a LinkCrypto provider that the
// caller hands to linkRoot and linkKeys: node:crypto on the Mac (Electron's built-in crypto) and in tests
// (sealed-node.ts), Apple's CryptoKit on the iPhone (apps/mobile/src/link-crypto.ts). Everything else reads the provider from the keys.
import * as string from "lib0/string";

/**
 * The primitives the link needs, all synchronous. `seal` and `open` are AES-256-GCM with a 32-byte key, a 12-byte
 * nonce and a 16-byte tag: `seal` returns ciphertext followed by the tag, and `open` takes the same and throws when
 * it does not authenticate.
 */
export interface LinkCrypto {
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array;
  random(length: number): Uint8Array;
}

/** The pairing-code version that carries a sealed link, and the first byte of every envelope and hello. */
export const LINK_VERSION = 3;

const SALT = string.encodeUtf8("coldopen-phone-link-v3");
const REQUEST_AAD = string.encodeUtf8("coldopen-link-v3 request");
const RESPONSE_AAD = string.encodeUtf8("coldopen-link-v3 response");
const KEY = 32, NONCE = 12, TAG = 16, KID = 16, RID = 24, RANDOM = 32;
const EMPTY = new Uint8Array(0);
/**
 * GCM must never see one nonce twice under one key: that reveals the XOR of the two plaintexts and lets anyone
 * forge tags. Each HTTP message key is derived from random request and response IDs and seals exactly one
 * message, so its nonce can be fixed at zero. (The Mac seals each answer under a fresh `sid`, so a replayed
 * request never reuses a response key either.)
 */
const ZERO_NONCE = new Uint8Array(NONCE);
const label = (text: string) => string.encodeUtf8(text);

/** Why a sealed message was refused. The message never says more than this, and never holds key material. */
export class LinkError extends Error {
  readonly kind: "malformed" | "unknown" | "forged" | "replayed" | "unanswered";
  constructor(kind: LinkError["kind"], message: string) { super(message); this.kind = kind; }
}

export type Random = (length: number) => Uint8Array;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

/** Unpadded base64url, written out so it does not depend on btoa or atob being present. */
export function toBase64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += ALPHABET[c & 63]!;
  }
  return out;
}

export function fromBase64url(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new LinkError("malformed", "Invalid sealed message.");
  const bytes = new Uint8Array(Math.floor(value.length * 3 / 4));
  let bits = 0, held = 0, at = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i), digit = code < 128 ? DECODE[code]! : -1;
    if (digit < 0) throw new LinkError("malformed", "Invalid sealed message.");
    held = (held << 6) | digit;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes[at++] = (held >> bits) & 255; }
  }
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function open(crypto: LinkCrypto, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (sealed.length < TAG) throw new LinkError("malformed", "Invalid sealed message.");
  try { return crypto.open(key, nonce, aad, sealed); }
  catch { throw new LinkError("forged", "The sealed message did not authenticate."); }
}

export interface LinkKeys {
  /** Public pairing ID: base64url of `kid`, 22 characters. It picks the key on the Mac and reveals nothing about it. */
  id: string;
  kid: Uint8Array;
  /** The key every other key comes from. The Mac keeps this for a remembered iPhone. */
  root: Uint8Array;
  /** Phone to Mac HTTP bodies: each request's key is derived from this and the request's ID. */
  request: Uint8Array;
  /** Mac to phone HTTP bodies: each response's key is derived from this, the request's ID and the response's. */
  response: Uint8Array;
  /** The primitives every operation on these keys uses. */
  crypto: LinkCrypto;
}

/** The root key for a pairing secret (the 43-character base64url token in the pairing code). */
export function linkRoot(crypto: LinkCrypto, secret: string): Uint8Array {
  const bytes = fromBase64url(secret);
  if (secret.length !== 43 || bytes.length !== KEY) throw new LinkError("malformed", "Invalid pairing secret.");
  return crypto.hkdf(bytes, SALT, label("root"), KEY);
}

export function linkKeys(crypto: LinkCrypto, root: Uint8Array): LinkKeys {
  if (root.length !== KEY) throw new LinkError("malformed", "Invalid link key.");
  const derive = (info: string, length: number) => crypto.hkdf(root, EMPTY, label(info), length);
  const kid = derive("kid", KID);
  return { id: toBase64url(kid), kid, root, request: derive("http phone to mac", KEY), response: derive("http mac to phone", KEY), crypto };
}

// ---- HTTP: one sealed request, one sealed response ----

export interface LinkRequest {
  /** When the phone made the request, in the Mac's clock (Unix milliseconds). */
  t: number;
  m: "GET" | "POST";
  /**
   * The Mac's run ID, as its last answer gave it. A request is run only when this names the Mac's current run, so a
   * request recorded before the Mac restarted is never run after it. Left out until the Mac has said what it is.
   */
  e?: string;
  /** The API path, such as /api/inbox. */
  p: string;
  /** The JSON body of a POST. */
  b?: unknown;
}

export interface LinkResponse {
  /** The HTTP status the request would have had. The outer response is always 200. */
  s: number;
  b: unknown;
  /** The Mac's clock, so a phone with a wrong clock can correct `t` and retry. */
  now: number;
  /** With status 425: the Mac's run ID, for the retry. */
  e?: string;
}

const requestKey = (keys: LinkKeys, rid: Uint8Array) => keys.crypto.hkdf(keys.request, rid, label("request"), KEY);
const responseKey = (keys: LinkKeys, rid: Uint8Array, sid: Uint8Array) =>
  keys.crypto.hkdf(keys.response, concat(rid, sid), label("response"), KEY);

/**
 * POST body for /link: base64url(version | kid | rid | ciphertext and tag). `rid` is 24 random bytes that name the
 * request: its key comes from them, the replay guard remembers them, and the response is bound to them.
 */
export function sealRequest(keys: LinkKeys, request: LinkRequest, rid: Uint8Array): string {
  if (rid.length !== RID) throw new LinkError("malformed", "Invalid request ID.");
  const sealed = keys.crypto.seal(requestKey(keys, rid), ZERO_NONCE, concat(REQUEST_AAD, keys.kid),
    string.encodeUtf8(JSON.stringify(request)));
  return toBase64url(concat(Uint8Array.of(LINK_VERSION), keys.kid, rid, sealed));
}

/** The pairing ID a sealed request names, without decrypting it. Null when it is not a sealed request at all. */
export function requestId(body: string): string | null {
  try {
    const head = fromBase64url(body.slice(0, 24));
    return head[0] === LINK_VERSION && body.length >= Math.ceil((1 + KID + RID + TAG) * 4 / 3)
      ? toBase64url(head.subarray(1, 1 + KID)) : null;
  } catch { return null; }
}

export function openRequest(keys: LinkKeys, body: string): { request: LinkRequest; rid: Uint8Array } {
  const bytes = fromBase64url(body);
  if (bytes.length < 1 + KID + RID + TAG || bytes[0] !== LINK_VERSION) throw new LinkError("malformed", "Invalid sealed request.");
  const kid = bytes.subarray(1, 1 + KID), rid = bytes.slice(1 + KID, 1 + KID + RID);
  if (toBase64url(kid) !== keys.id) throw new LinkError("unknown", "This pairing is not known here.");
  const plain = open(keys.crypto, requestKey(keys, rid), ZERO_NONCE, concat(REQUEST_AAD, keys.kid), bytes.subarray(1 + KID + RID));
  let request: LinkRequest;
  try { request = JSON.parse(string.decodeUtf8(plain)); } catch { throw new LinkError("malformed", "Invalid sealed request."); }
  if (!request || typeof request !== "object" || !Number.isSafeInteger(request.t) || (request.m !== "GET" && request.m !== "POST")
      || typeof request.p !== "string" || !request.p.startsWith("/") || request.p.length > 200
      || (request.e !== undefined && typeof request.e !== "string"))
    throw new LinkError("malformed", "Invalid sealed request.");
  return { request, rid };
}

/**
 * base64url(sid | ciphertext and tag), `sid` 24 random bytes. The response is bound to the request's ID through
 * its key and its AAD, so an old response never answers a new request.
 */
export function sealResponse(keys: LinkKeys, rid: Uint8Array, response: LinkResponse, sid: Uint8Array): string {
  if (sid.length !== RID || rid.length !== RID) throw new LinkError("malformed", "Invalid request ID.");
  const sealed = keys.crypto.seal(responseKey(keys, rid, sid), ZERO_NONCE, concat(RESPONSE_AAD, rid),
    string.encodeUtf8(JSON.stringify(response)));
  return toBase64url(concat(sid, sealed));
}

export function openResponse(keys: LinkKeys, rid: Uint8Array, body: string): LinkResponse {
  const bytes = fromBase64url(body.trim());
  if (bytes.length < RID + TAG || rid.length !== RID) throw new LinkError("malformed", "Invalid sealed response.");
  const sid = bytes.subarray(0, RID);
  const plain = open(keys.crypto, responseKey(keys, rid, sid), ZERO_NONCE, concat(RESPONSE_AAD, rid), bytes.subarray(RID));
  let response: LinkResponse;
  try { response = JSON.parse(string.decodeUtf8(plain)); } catch { throw new LinkError("malformed", "Invalid sealed response."); }
  if (!response || typeof response !== "object" || !Number.isInteger(response.s)) throw new LinkError("malformed", "Invalid sealed response.");
  return response;
}

/**
 * Refuses a captured request sent again. A request is fresh when it names this guard's run, its time is within the
 * window of the Mac's clock, and its request ID has not been seen. The run ID is random and made when the guard is,
 * so it changes whenever the Mac forgets which request IDs it has seen (a restart): a request recorded in an earlier
 * run names the wrong run and is never run again, whatever its timestamp says. The time window only bounds how long
 * a request ID must be remembered.
 */
export class ReplayGuard {
  /** Names this run. Not a secret: the phone learns it from a sealed answer and sends it back sealed. */
  readonly run: string;
  private readonly seen = new Map<string, number>();
  private readonly window: number;
  private readonly limit: number;
  private pruned = 0;
  constructor(crypto: LinkCrypto, window = 120_000, limit = 8192) {
    this.window = window; this.limit = limit; this.run = toBase64url(crypto.random(16));
  }
  admit(run: string | undefined, t: number, rid: Uint8Array, now = Date.now()): "fresh" | "stale" | "replayed" | "busy" {
    if (run !== this.run || !Number.isSafeInteger(t) || Math.abs(now - t) > this.window) return "stale";
    const id = toBase64url(rid);
    if (this.seen.has(id)) return "replayed";
    if (now - this.pruned > 5000 || this.seen.size >= this.limit) {
      this.pruned = now;
      // A request ID can be forgotten once its request would be stale anyway.
      for (const [key, at] of this.seen) if (at < now - this.window) this.seen.delete(key);
    }
    if (this.seen.size >= this.limit) return "busy";
    this.seen.set(id, t);
    return "fresh";
  }
}

/**
 * The Mac's side of one sealed request: open it, refuse replays, run the handler, seal the answer. Throws LinkError
 * when the request does not authenticate or was seen before; the caller answers those in the clear with no detail.
 */
export async function answerSealed(keys: LinkKeys, guard: ReplayGuard, body: string,
    handle: (request: LinkRequest) => Promise<{ status: number; body: unknown }>,
    random: Random = (length) => keys.crypto.random(length), clock: () => number = Date.now): Promise<string> {
  const { request, rid } = openRequest(keys, body);
  const fresh = guard.admit(request.e, request.t, rid, clock());
  if (fresh === "replayed") throw new LinkError("replayed", "This request was already received.");
  const reply = fresh === "fresh" ? await handle(request)
    : fresh === "busy" ? { status: 429, body: { error: "Too many requests." } }
    // 425: the request names another run of the Mac, or the phone's clock differs from the Mac's. It is not run.
    // The sealed answer carries the run ID and the Mac's time for one retry.
    : { status: 425, body: { error: "Check the time on both devices." } };
  return sealResponse(keys, rid, { s: reply.status, b: reply.body, now: clock(), ...(reply.status === 425 ? { e: guard.run } : {}) }, random(RID));
}

/**
 * The phone's side: seals each call, checks the answer, and follows the Mac's run ID and clock. The first call to a
 * Mac, and the first after the Mac restarts, costs one extra round trip to learn them.
 */
export class LinkClient {
  private offset = 0;
  private run: string | undefined;
  private readonly keys: LinkKeys;
  private readonly post: (body: string, signal?: AbortSignal) => Promise<string>;
  private readonly random: Random;
  private readonly clock: () => number;
  /** `post` sends the body to the Mac's /link and returns the response text, or throws when there is none. */
  constructor(keys: LinkKeys, post: (body: string, signal?: AbortSignal) => Promise<string>,
      random: Random = (length) => keys.crypto.random(length), clock: () => number = Date.now) {
    this.keys = keys; this.post = post; this.random = random; this.clock = clock;
  }
  async call(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: any }> {
    for (let attempt = 0; ; attempt++) {
      const rid = this.random(RID);
      const sealed = sealRequest(this.keys, { t: this.clock() + this.offset, ...(this.run ? { e: this.run } : {}), m: method, p: path,
        ...(body === undefined ? {} : { b: body }) }, rid);
      const reply = openResponse(this.keys, rid, await this.post(sealed, signal));
      if (reply.s === 425 && attempt === 0 && Number.isSafeInteger(reply.now) && typeof reply.e === "string") {
        this.offset = reply.now - this.clock();
        this.run = reply.e;
        continue;
      }
      return { status: reply.s, body: reply.b };
    }
  }
}

// ---- WebSocket: a sealed tunnel around the relay's messages ----

/** What a sealed WebSocket message carries, as the first byte of its plaintext. */
export const FRAME_DATA = 0;
/** The phone's first sealed message: JSON `{ room, key }`, the room it wants and its read-only key. */
export const FRAME_JOIN = 1;
/** The Mac's last sealed message: JSON `{ code, reason }`, the close code the phone may believe. */
export const FRAME_CLOSE = 2;

/** The first message each way: version | 32 random bytes, in the clear. Both randoms go into the session keys. */
export function hello(random: Uint8Array): Uint8Array {
  if (random.length !== RANDOM) throw new LinkError("malformed", "Invalid hello.");
  return concat(Uint8Array.of(LINK_VERSION), random);
}
export function readHello(frame: Uint8Array): Uint8Array {
  if (frame.length !== 1 + RANDOM || frame[0] !== LINK_VERSION) throw new LinkError("malformed", "Invalid hello.");
  return frame.slice(1);
}

/**
 * One direction's keys and counters for a connection. Keys are fresh per connection (both sides contribute a
 * random), so a message recorded on one connection never opens on another. Within a connection the nonce is four
 * zero bytes and a 64-bit big-endian counter that is not sent: a message that is replayed, dropped or reordered
 * fails to open.
 */
export class Tunnel {
  private readonly crypto: LinkCrypto;
  private readonly sendKey: Uint8Array;
  private readonly receiveKey: Uint8Array;
  private sent = 0;
  private received = 0;
  constructor(keys: LinkKeys, clientRandom: Uint8Array, serverRandom: Uint8Array, side: "phone" | "mac") {
    this.crypto = keys.crypto;
    const salt = concat(clientRandom, serverRandom);
    const derive = (info: string) => keys.crypto.hkdf(keys.root, salt, label(info), KEY);
    const up = derive("ws phone to mac"), down = derive("ws mac to phone");
    this.sendKey = side === "phone" ? up : down;
    this.receiveKey = side === "phone" ? down : up;
  }
  /**
   * Four zero bytes and the message counter. Each connection has its own keys (both randoms go into them) and each
   * direction its own key and counter, which only goes up, so no nonce repeats under a key, as GCM requires.
   */
  private static nonce(counter: number): Uint8Array {
    const nonce = new Uint8Array(NONCE), view = new DataView(nonce.buffer);
    view.setUint32(NONCE - 8, Math.floor(counter / 0x100000000));
    view.setUint32(NONCE - 4, counter >>> 0);
    return nonce;
  }
  seal(type: number, payload: Uint8Array): Uint8Array {
    if (this.sent >= Number.MAX_SAFE_INTEGER) throw new LinkError("malformed", "This connection has sent too many messages.");
    return this.crypto.seal(this.sendKey, Tunnel.nonce(this.sent++), EMPTY, concat(Uint8Array.of(type), payload));
  }
  open(frame: Uint8Array): { type: number; payload: Uint8Array } {
    const plain = open(this.crypto, this.receiveKey, Tunnel.nonce(this.received), EMPTY, frame);
    this.received++;
    if (!plain.length) throw new LinkError("malformed", "Invalid sealed message.");
    return { type: plain[0]!, payload: plain.subarray(1) };
  }
}

const utf8Json = (value: unknown) => string.encodeUtf8(JSON.stringify(value));
export const joinFrame = (room: string, key: string) => utf8Json({ room, key });
export const closeFrame = (code: number, reason: string) => utf8Json({ code, reason });
export function readJson(payload: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(string.decodeUtf8(payload));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* Refused below. */ }
  throw new LinkError("malformed", "Invalid sealed message.");
}

/** The path a sealed WebSocket opens. The room and its key travel inside the tunnel, never in the URL. */
export const sealedPath = (keys: LinkKeys) => `/sealed/${keys.id}`;

/**
 * A WebSocket class for RelayClient that runs the relay protocol through a sealed tunnel. RelayClient builds
 * `<relay>/<room>?key=<key>` as usual; this class opens `<relay>/sealed/<id>` instead and sends the room and key
 * encrypted. A close code is believed only when it arrived sealed: any other close reads as a lost connection
 * (1006), so someone on the network cannot end a pairing by forging a close.
 */
export function sealedWebSocket(keys: LinkKeys, Raw: typeof WebSocket = globalThis.WebSocket,
    random: Random = (length) => keys.crypto.random(length)): typeof WebSocket {
  class SealedSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    binaryType = "arraybuffer";
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    private readonly raw: WebSocket;
    private tunnel: Tunnel | undefined;
    constructor(url: string) {
      const target = /^(wss?:\/\/[^/?#]+)\/([^/?#]+)\?key=([^&#]+)$/.exec(url);
      if (!target) throw new LinkError("malformed", "Invalid relay address.");
      const room = decodeURIComponent(target[2]!), key = decodeURIComponent(target[3]!);
      const raw = this.raw = new Raw(target[1]! + sealedPath(keys));
      raw.binaryType = "arraybuffer";
      raw.onmessage = (event) => {
        if (this.readyState === 3) return;
        try {
          const frame = new Uint8Array(event.data as ArrayBuffer);
          if (!this.tunnel) {
            const clientRandom = random(RANDOM);
            this.tunnel = new Tunnel(keys, clientRandom, readHello(frame), "phone");
            raw.send(hello(clientRandom));
            raw.send(this.tunnel.seal(FRAME_JOIN, joinFrame(room, key)));
            this.readyState = 1;
            this.onopen?.();
            return;
          }
          const { type, payload } = this.tunnel.open(frame);
          if (type === FRAME_DATA) {
            this.onmessage?.({ data: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer });
          } else if (type === FRAME_CLOSE) {
            const notice = readJson(payload);
            this.finish(Number.isInteger(notice.code) ? notice.code as number : 1006, typeof notice.reason === "string" ? notice.reason : "");
          }
        } catch { this.finish(1006, ""); }
      };
      raw.onerror = (event) => this.onerror?.(event);
      raw.onclose = () => this.finish(1006, "");
    }
    send(data: Uint8Array): void {
      if (this.readyState === 1 && this.tunnel) this.raw.send(this.tunnel.seal(FRAME_DATA, data));
    }
    close(): void { this.finish(1000, ""); }
    private finish(code: number, reason: string): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.raw.onmessage = null; this.raw.onerror = null; this.raw.onclose = null;
      try { this.raw.close(); } catch { /* Already closed. */ }
      this.onclose?.({ code, reason });
    }
  }
  return SealedSocket as unknown as typeof WebSocket;
}
