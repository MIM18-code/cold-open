// Hosting a co-writing session: the embedded relay, started only when a writer shares and closed when the last
// window stops sharing. Each sharing window gets its own room with fresh random keys. Keys are never logged.
import { execFile } from "node:child_process";
import { networkInterfaces, userInfo } from "node:os";

import { createRelay, formatInvite, type Relay, type RoomKeys } from "@screenplay/relay";

import type { HostInfo } from "../../shared/channels/sync.ts";
import { tailscaleOwnAddress } from "../phone/tailscale.ts";

/** This Mac's LAN IPv4 address, preferring Wi-Fi and Ethernet (en*) over VPNs and bridges. `tailscale` is left out:
 * it gets its own invite. Other 100.64.0.0/10 addresses (a carrier network, another VPN) are ordinary addresses. */
export function lanAddress(interfaces = networkInterfaces(), tailscale: string | null = null): string | null {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.") || entry.address === tailscale) continue;
      candidates.push({ name, address: entry.address });
    }
  }
  candidates.sort((a, b) => Number(!a.name.startsWith("en")) - Number(!b.name.startsWith("en")) || a.name.localeCompare(b.name));
  return candidates[0]?.address ?? null;
}

/** The macOS account's full name ("Maya Lopez"), falling back to the short user name. */
export function fullUserName(): Promise<string> {
  const fallback = () => {
    try {
      return userInfo().username;
    } catch {
      return "";
    }
  };
  if (process.platform !== "darwin") return Promise.resolve(fallback());
  return new Promise((resolve) => {
    execFile("/usr/bin/id", ["-F"], { timeout: 2000 }, (error, stdout) => resolve(!error && stdout.trim() ? stdout.trim() : fallback()));
  });
}

/**
 * What one Mac's co-writing relay accepts. It listens on the local network, so anyone there can open sockets, and a
 * guest with an invite can send edits and presence. These sit far above what a writing session uses: a script's
 * whole state is a few megabytes and its presence a few hundred bytes.
 */
const HOST_LIMITS = { maxConnections: 32, maxDocBytes: 32 * 1024 * 1024, maxAwarenessBytes: 64 * 1024, maxAwarenessClients: 8 };

export class Host {
  private relay: Relay | null = null;
  private starting: Promise<Relay> | null = null;
  private readonly rooms = new Map<number, RoomKeys>();
  /** Starts waiting for the relay. Such a window has no room yet for stop() to close, so stop() marks its starts. */
  private readonly waiting = new Set<{ owner: number; stopped: boolean }>();
  /** "0.0.0.0" to accept other Macs; "127.0.0.1" in tests, so no firewall prompt appears. */
  private readonly bindHost: string;
  private readonly interfaces: typeof networkInterfaces;
  /** Tailscale's own report of this Mac's address: an address in Tailscale's range alone isn't proof. */
  private readonly tailscale: () => Promise<string | null>;
  private readonly createRelay: typeof createRelay;

  constructor(bindHost: string, options: { networkInterfaces?: typeof networkInterfaces; tailscale?: () => Promise<string | null>; createRelay?: typeof createRelay } = {}) {
    this.bindHost = bindHost;
    // Loopback tests advertise only loopback unless they supply fake interfaces.
    const loopback = bindHost === "127.0.0.1";
    this.interfaces = options.networkInterfaces ?? (loopback ? () => ({}) : networkInterfaces);
    this.tailscale = options.tailscale ?? (loopback ? async () => null : () => tailscaleOwnAddress());
    this.createRelay = options.createRelay ?? createRelay;
  }

  isHosting(owner: number): boolean {
    return this.rooms.has(owner);
  }

  async start(owner: number): Promise<HostInfo> {
    const attempt = { owner, stopped: false };
    this.waiting.add(attempt);
    let relay: Relay, keys: RoomKeys;
    try {
      relay = await this.ensureRelay();
      // The window closed, or stopped sharing, while the relay was starting. Making its room now would leave the
      // relay listening for a window that is gone.
      if (attempt.stopped) throw new Error("Sharing was stopped before it started.");
      keys = this.rooms.get(owner) ?? relay.createRoom();
      this.rooms.set(owner, keys);
    } finally {
      this.waiting.delete(attempt);
      if (!this.rooms.size && !this.waiting.size) await this.close();
    }
    const tail = await this.tailscale().catch(() => null);
    const lan = lanAddress(this.interfaces(), tail);
    const address = `${lan ?? tail ?? "127.0.0.1"}:${relay.port}`;
    const base = `ws://${address}`;
    const tailscale = tail ? {
      address: `${tail}:${relay.port}`,
      invite: formatInvite({ relay: `ws://${tail}:${relay.port}`, room: keys.room, key: keys.key, readOnly: false }),
      readOnlyInvite: formatInvite({ relay: `ws://${tail}:${relay.port}`, room: keys.room, key: keys.readKey, readOnly: true }),
    } : null;
    return {
      relay: `ws://127.0.0.1:${relay.port}`,
      room: keys.room,
      key: keys.key,
      invite: formatInvite({ relay: base, room: keys.room, key: keys.key, readOnly: false }),
      readOnlyInvite: formatInvite({ relay: base, room: keys.room, key: keys.readKey, readOnly: true }),
      address,
      lan: !!lan,
      tailscale,
    };
  }

  async stop(owner: number): Promise<void> {
    for (const attempt of this.waiting) if (attempt.owner === owner) attempt.stopped = true;
    const keys = this.rooms.get(owner);
    if (!keys) return;
    this.rooms.delete(owner);
    this.relay?.closeRoom(keys.room);
    // Another window may be waiting for this relay to make its own room.
    if (!this.rooms.size && !this.waiting.size) await this.close();
  }

  async close(): Promise<void> {
    const relay = this.relay, starting = this.starting;
    // Before any await: a start still waiting must not make a room on the relay being closed, and a start that
    // comes later must bind a relay of its own.
    this.relay = null;
    this.starting = null;
    this.rooms.clear();
    for (const attempt of this.waiting) attempt.stopped = true;
    await (relay ?? (await starting?.catch(() => null)))?.close();
  }

  private async ensureRelay(): Promise<Relay> {
    if (this.relay) return this.relay;
    const starting = this.starting ??= this.createRelay({ host: this.bindHost, port: 0, allowClaim: false, ...HOST_LIMITS });
    try {
      const relay = await starting;
      // close() takes a relay that is still starting; that one is not kept.
      if (this.starting === starting) this.relay = relay;
      return relay;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }
}
