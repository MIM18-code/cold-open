// The pieces both sides of the relay share: message and close codes, room keys, and the invite format.
// Nothing here uses Node APIs, so the browser client and the phone can import it. docs/sync-protocol.md
// describes the wire format for clients written elsewhere (Backlot).

/** First varUint of every WebSocket message, as in y-websocket. */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;

/** Close codes the relay sends. Clients stop reconnecting on the first three. */
export const CLOSE_DENIED = 4401;
export const CLOSE_NO_ROOM = 4404;
export const CLOSE_BAD_MESSAGE = 4400;
/** A self-hosted relay has no such room yet and the key cannot open it (a read-only key). Retry with backoff. */
export const CLOSE_NOT_OPEN = 4425;

/** Room names and keys: 128 random bits, base64url without padding (22 characters). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const READ_KEY_PREFIX = "screenplay-read-key:";
export const ROOM_PREFIX = "screenplay-room:";

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random 128-bit room name or key. */
export function randomId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The read-only key for a room key: the first 128 bits of SHA-256("screenplay-read-key:" + key). Anyone with the
 * read-write key can derive it; the read-only key does not reveal the read-write key.
 */
export async function deriveReadKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(READ_KEY_PREFIX + key));
  return base64url(new Uint8Array(digest).subarray(0, 16));
}

/**
 * The room name for a room key: the first 128 bits of SHA-256("screenplay-room:" + key). Only someone holding the
 * read-write key can show a relay that it owns a room, so a read-only key can never open (or reopen) one.
 */
export async function deriveRoom(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ROOM_PREFIX + key));
  return base64url(new Uint8Array(digest).subarray(0, 16));
}

export interface Invite {
  /** WebSocket base URL of the relay, such as ws://192.168.1.20:52144 or wss://relay.example.com. */
  relay: string;
  room: string;
  key: string;
  /** The key is a read-only key. A hint for the joining app; the relay enforces it either way. */
  readOnly: boolean;
}

/**
 * screenplay://join?host=192.168.1.20:52144&room=…&key=…[&access=read]
 * A relay that is not plain ws:// on a host and port goes in relay= instead of host=.
 */
export function formatInvite(invite: Invite): string {
  const params = new URLSearchParams();
  const plain = /^ws:\/\/([^/?#]+)\/?$/.exec(invite.relay);
  if (plain) params.set("host", plain[1]!);
  else params.set("relay", invite.relay);
  params.set("room", invite.room);
  params.set("key", invite.key);
  if (invite.readOnly) params.set("access", "read");
  return `screenplay://join?${params}`;
}

/** Check the base URL before opening a socket or putting it in a shareable invite. */
export function validRelayAddress(relay: string): boolean {
  if (!/^wss?:\/\/[^/]/i.test(relay) || /[?#\\\s]/.test(relay)) return false;
  try {
    const endpoint = new URL(relay);
    return !!endpoint.hostname && !endpoint.username && !endpoint.password;
  } catch { return false; }
}

export function parseInvite(text: string): Invite {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error("That is not a co-writing invite.");
  }
  if (url.protocol !== "screenplay:" || url.host !== "join" || (url.pathname && url.pathname !== "/") || url.username || url.password)
    throw new Error("That is not a co-writing invite.");
  const params = url.searchParams;
  const host = params.get("host");
  const relay = host ? `ws://${host}` : params.get("relay");
  const room = params.get("room") ?? "";
  const key = params.get("key") ?? "";
  if (!relay) throw new Error("The invite has no relay address.");
  if (!validRelayAddress(relay) || (host && host.includes("/")))
    throw new Error("The invite has an invalid server address. Ask the writer for a new invite.");
  if (!ID_PATTERN.test(room) || !ID_PATTERN.test(key)) throw new Error("The invite is incomplete. Copy the whole invite and try again.");
  return { relay: relay.replace(/\/+$/, ""), room, key, readOnly: params.get("access") === "read" };
}

/** The WebSocket URL a client opens: the relay, the room as the path, the key as a query parameter. */
export function roomUrl(relay: string, room: string, key: string): string {
  return `${relay.replace(/\/+$/, "")}/${encodeURIComponent(room)}?key=${encodeURIComponent(key)}`;
}
