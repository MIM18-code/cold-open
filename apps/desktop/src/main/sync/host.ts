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
    execFile("id", ["-F"], { timeout: 2000 }, (error, stdout) => resolve(!error && stdout.trim() ? stdout.trim() : fallback()));
  });
}

export class Host {
  private relay: Relay | null = null;
  private starting: Promise<Relay> | null = null;
  private readonly rooms = new Map<number, RoomKeys>();
  /** "0.0.0.0" to accept other Macs; "127.0.0.1" in tests, so no firewall prompt appears. */
  private readonly bindHost: string;
  private readonly interfaces: typeof networkInterfaces;
  /** Tailscale's own report of this Mac's address: an address in Tailscale's range alone isn't proof. */
  private readonly tailscale: () => Promise<string | null>;

  constructor(bindHost: string, options: { networkInterfaces?: typeof networkInterfaces; tailscale?: () => Promise<string | null> } = {}) {
    this.bindHost = bindHost;
    // Loopback tests advertise only loopback unless they supply fake interfaces.
    const loopback = bindHost === "127.0.0.1";
    this.interfaces = options.networkInterfaces ?? (loopback ? () => ({}) : networkInterfaces);
    this.tailscale = options.tailscale ?? (loopback ? async () => null : () => tailscaleOwnAddress());
  }

  isHosting(owner: number): boolean {
    return this.rooms.has(owner);
  }

  async start(owner: number): Promise<HostInfo> {
    const relay = await this.ensureRelay();
    let keys = this.rooms.get(owner);
    if (!keys) {
      keys = relay.createRoom();
      this.rooms.set(owner, keys);
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
    const keys = this.rooms.get(owner);
    if (!keys) return;
    this.rooms.delete(owner);
    this.relay?.closeRoom(keys.room);
    if (!this.rooms.size) await this.close();
  }

  async close(): Promise<void> {
    const relay = this.relay ?? (await this.starting?.catch(() => null));
    this.relay = null;
    this.starting = null;
    this.rooms.clear();
    await relay?.close();
  }

  private async ensureRelay(): Promise<Relay> {
    if (this.relay) return this.relay;
    this.starting ??= createRelay({ host: this.bindHost, port: 0, allowClaim: false });
    try {
      this.relay = await this.starting;
      return this.relay;
    } finally {
      this.starting = null;
    }
  }
}
