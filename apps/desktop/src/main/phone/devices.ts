import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { openForRead, replaceFile } from "../safe-fs.ts";
import type { FolderGrant } from "./folder.ts";
import type { PhoneInboxStore } from "./inbox.ts";
import { phoneContent, phoneReceiptKey, type PhoneInbox } from "../../shared/channels/phone.ts";

export const receiptId = /^[-\w]{12,80}$/;
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function matchesToken(token: string, hash: string) {
  const a = Buffer.from(digest(token)), b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
export interface RememberedPhone {
  id: string; name: string; tokenHash: string; writerKey: string; scriptId: string;
  created: number; lastSeen: number; revoked?: boolean;
  address: string; hostname?: string; encrypted: boolean;
}
interface Receipt { deviceId: string; scriptId: string; signature: string; outcome?: "accepted" | "ignored"; }
interface State { devices: RememberedPhone[]; receipts: Record<string, Receipt>; folder?: FolderGrant; }
export class PhoneDevices {
  private state: State = { devices: [], receipts: {} };
  private tail: Promise<unknown> = Promise.resolve();
  readonly path: string;
  constructor(path: string) { this.path = path; }
  async load() {
    const file = await openForRead(this.path);
    if (!file) return;
    try {
      if (file.info.size > 24000000) throw new Error("The remembered phone state is too large.");
      const value = JSON.parse(new TextDecoder().decode(await file.read(24000000)));
      if (!Array.isArray(value.devices) || !value.receipts || typeof value.receipts !== "object")
        throw new Error("The remembered phone state is damaged.");
      this.state = value;
    } finally { await file.close(); }
  }
  private async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await replaceFile(this.path, this.path + "." + randomUUID() + ".saving", JSON.stringify(this.state), 0o600);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(async () => {
      const previous = structuredClone(this.state);
      try { return await fn(); } catch (e) { this.state = previous; throw e; }
    });
    this.tail = next;
    return next;
  }
  all() { return structuredClone(this.state.devices); }
  device(id: string) { return this.all().find(d => d.id === id); }
  verifyTake(deviceId: string, scriptId: string, item: PhoneInbox, sig: unknown): boolean {
    const device = this.state.devices.find(d => d.id === deviceId && !d.revoked && d.scriptId === scriptId);
    if (!device || !/^[a-f0-9]{64}$/.test(device.tokenHash)
        || typeof sig !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
    // Signed domain string; the iPhone app signs the same text, so it keeps the old app name.
    const message = JSON.stringify(["inklot-take-v1", deviceId, scriptId, item.id,
      item.kind, item.text, item.paragraphId, item.sourceText]);
    const expected = createHmac("sha256", Buffer.from(device.tokenHash, "hex")).update(message).digest();
    const supplied = Buffer.from(sig, "base64url");
    return supplied.toString("base64url") === sig && supplied.length === expected.length
      && timingSafeEqual(supplied, expected);
  }
  folder() { return this.state.folder; }
  setFolder(grant: FolderGrant) { return this.serial(async () => { this.state.folder = grant; await this.save(); }); }
  create(scriptId: string, address: string, hostname?: string, encrypted = true) {
    return this.serial(async () => {
      if (this.state.devices.filter(d => !d.revoked).length >= 100) throw new Error("Revoke an old iPhone before remembering another.");
      const token = randomBytes(32).toString("base64url");
      const device: RememberedPhone = { id: randomUUID(), scriptId, address, hostname, encrypted,
        name: "iPhone awaiting connection", tokenHash: digest(token), writerKey: randomBytes(16).toString("base64url"),
        created: Date.now(), lastSeen: 0 };
      this.state.devices.push(device);
      await this.save();
      return { device: structuredClone(device), token };
    });
  }
  seen(id: string, name?: string) {
    return this.serial(async () => {
      const device = this.state.devices.find(d => d.id === id && !d.revoked);
      if (!device) throw new Error("This Mac revoked the pairing");
      if (name !== undefined) {
        if (typeof name !== "string" || !name.trim() || name.length > 100) throw new Error("Invalid iPhone name.");
        device.name = name.trim();
      }
      if (name || Date.now() - device.lastSeen > 60000) {
        device.lastSeen = Date.now();
        await this.save();
      }
    });
  }
  revoke(id: string) {
    return this.serial(async () => {
      const device = this.state.devices.find(d => d.id === id);
      if (device) { device.revoked = true; await this.save(); }
    });
  }
  async receive(deviceId: string, scriptId: string, item: PhoneInbox, store: PhoneInboxStore): Promise<boolean> {
    return this.serial(async () => {
      const device = this.state.devices.find(d => d.id === deviceId && !d.revoked);
      if (!device || device.scriptId !== scriptId) throw new Error("This item is not paired to this script.");
      const key = phoneReceiptKey({ id: item.id, deviceId });
      const signature = digest(phoneContent(item));
      const receipt = this.state.receipts[key];
      if (receipt) {
        if (receipt.signature !== signature) throw new Error("That receipt ID was already used for different content.");
        return false;
      }
      await store.append(scriptId, { ...item, deviceId });
      this.state.receipts[key] = { deviceId, scriptId, signature };
      await this.save();
      return true;
    });
  }
  async migrateInbox(store: PhoneInboxStore) {
    for (const scriptId of new Set(Object.values(this.state.receipts).map(r => r.scriptId))) {
      await store.attributeLegacy(scriptId, item => {
        const signature = digest(phoneContent(item));
        const matches = Object.entries(this.state.receipts).filter(([key, r]) =>
          r.scriptId === scriptId && key === phoneReceiptKey({ id: item.id, deviceId: r.deviceId })
          && r.signature === signature);
        return matches.length === 1 ? matches[0]![1].deviceId : undefined;
      });
    }
  }
  decisions(deviceId: string) {
    return Object.fromEntries(Object.entries(this.state.receipts)
      .filter(([, r]) => r.deviceId === deviceId && r.outcome)
      .map(([key, r]) => [key.slice(deviceId.length + 1), { outcome: r.outcome, contentHash: r.signature }]));
  }
  decide(scriptId: string, id: string, outcome: "accepted" | "ignored", deviceId?: string) {
    return this.serial(async () => {
      const receipt = this.state.receipts[phoneReceiptKey({ id, deviceId })];
      if (receipt?.scriptId === scriptId && receipt.deviceId === deviceId) receipt.outcome = outcome;
      await this.save();
    });
  }
  flush() { return this.tail; }
}
