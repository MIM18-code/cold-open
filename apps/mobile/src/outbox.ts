import { LinkClient, LinkError } from "@screenplay/relay/sealed";
import { contentHash, signTake, type Sha256 } from "./signing.ts";
import { PAIR_AGAIN, type Pairing } from "./pairing.ts";

export type Outcome = "pending" | "saved" | "airdropped" | "rejected" | "delivered" | "accepted" | "ignored";
export type Take = {
  id: string; room: string; kind: "scene-after" | "scene-end" | "draft" | "dictation" | "note"; text: string; paragraphId: string;
  sourceText: string; scene: string; created: number; outcome: Outcome; error?: string;
};

export class DeliveryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function inboxBody(item: Take) {
  return { id: item.id, kind: item.kind, text: item.text,
    paragraphId: item.paragraphId, sourceText: item.sourceText };
}
export function validateTakeSize(item: Take) {
  if (item.text.length > 20000 || new TextEncoder().encode(JSON.stringify({ ...inboxBody(item),
      ...(item.kind.startsWith("scene-") ? { v: 2, sig: "a".repeat(43) } : {}) })).length > 24000)
    throw new DeliveryError(413, "This item exceeds the Mac’s 24,000-byte limit. Shorten it or split it into separate notes.");
}
export function permanentFailure(e: unknown): e is DeliveryError {
  return e instanceof DeliveryError && ([400, 413, 422].includes(e.status)
    || e.status === 409 && e.message.includes("already used"));
}
export async function folderItem(pair: Pairing, item: Take, hash?: Sha256) {
  if (!pair.remembered || !pair.deviceId || !pair.scriptId || item.room !== pair.invite.room)
    throw new Error("Remember this iPhone on the Mac before using the folder fallback.");
  validateTakeSize(item);
  return JSON.stringify({ v: item.kind.startsWith("scene-") ? 2 : 1, deviceId: pair.deviceId, scriptId: pair.scriptId, ...inboxBody(item),
    sig: await signTake(pair.token, pair.deviceId, pair.scriptId, item, hash) });
}
export async function sendPending(pair: Pairing, items: Take[], signal: AbortSignal,
  update: (id: string, state: Outcome, error?: string) => void, hash?: Sha256) {
  for (const item of [...items].reverse().filter(t => t.room === pair.invite.room
      && (t.outcome === "pending" || t.outcome === "saved" || t.outcome === "airdropped")).slice(0, 8)) {
    try { await deliver(pair, item, signal, hash); update(item.id, "delivered"); }
    catch (e) {
      if (permanentFailure(e)) { update(item.id, "rejected", e.message); continue; }
      throw e;
    }
  }
}
export async function deviceStatus(pair: Pairing, signal: AbortSignal, name?: string) {
  if (!pair.remembered) return { open: true };
  return request(pair, "/api/device", signal, undefined, name);
}
// One sealed client per pairing, so a correction for this iPhone's clock is learned once.
const links = new WeakMap<Pairing, LinkClient>();
function linkClient(pair: Pairing): LinkClient {
  let client = links.get(pair);
  if (!client) links.set(pair, client = new LinkClient(pair.link!, async (sealed, signal) => {
    const response = await fetch(pair.origin + "/link", {
      signal, redirect: "error", method: "POST", headers: { "Content-Type": "text/plain" }, body: sealed,
    });
    // Anything but a sealed answer could come from anyone on the network, so it only means "not reached".
    if (!response.ok) throw new LinkError("unanswered", "The Mac did not answer this pairing.");
    return response.text();
  }));
  return client;
}
async function request(pair: Pairing, path: string, signal: AbortSignal, item?: Take, name?: string, hash?: Sha256) {
  if (Date.now() >= pair.expiresAt) throw new DeliveryError(410, "Pairing expired");
  // A pairing from before Wi-Fi links were encrypted never puts its token on the network again.
  if (pair.legacy) throw new DeliveryError(426, PAIR_AGAIN);
  const body = item ? { ...inboxBody(item), ...(item.kind.startsWith("scene-") ? { v: 2, sig: await signTake(pair.token, pair.deviceId ?? "", pair.scriptId ?? "", item, hash) } : {}) }
    : name ? { name } : undefined;
  if (pair.link) {
    // Wi-Fi: the request and the answer are sealed. The token is a key here and is never sent.
    const reply = await linkClient(pair).call(body ? "POST" : "GET", path, body, signal).catch(e => {
      if (e instanceof LinkError) throw new DeliveryError(502, "The Mac did not answer this pairing.");
      throw e;
    });
    if (reply.status < 200 || reply.status > 299) throw new DeliveryError(reply.status, reply.body?.error || "The Mac could not save the item.");
    return reply.body;
  }
  // The bearer goes out only inside TLS (Tailscale).
  if (!pair.origin.startsWith("https://")) throw new DeliveryError(426, PAIR_AGAIN);
  const response = await fetch(pair.origin + path, {
    signal, redirect: "error", method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + pair.token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({ error: "The Mac could not save the item." }));
  if (!response.ok) throw new DeliveryError(response.status, json.error || "The Mac could not save the item.");
  return json;
}

export async function deliver(pair: Pairing, item: Take, signal: AbortSignal, hash?: Sha256) {
  if (item.room !== pair.invite.room) throw new Error("This take belongs to a different pairing.");
  validateTakeSize(item);
  const receipt = await request(pair, "/api/inbox", signal, item, undefined, hash);
  if (receipt?.id !== item.id) throw new Error("The Mac returned a different receipt.");
}

type Decision = { outcome: "accepted" | "ignored"; contentHash?: string };
export function outcomes(value: unknown): Map<string, Decision> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid receipts.");
  const result = new Map<string, Decision>();
  for (const [id, decision] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[-\w]{12,80}$/.test(id)) continue;
    const row = typeof decision === "string" ? { outcome: decision } : decision;
    if (!row || typeof row !== "object" || !("outcome" in row)) continue;
    if (row.outcome === "accepted" || row.outcome === "ignored") {
      const hash = "contentHash" in row && typeof row.contentHash === "string" ? row.contentHash : undefined;
      result.set(id, { outcome: row.outcome, contentHash: hash });
    }
  }
  return result;
}

export async function syncReceipts(pair: Pairing, signal: AbortSignal, items: Take[], hash?: Sha256) {
  const decisions = outcomes(await request(pair, "/api/receipts", signal));
  const result = new Map<string, "accepted" | "ignored" | "conflict">();
  for (const item of items.filter(t => t.room === pair.invite.room)) {
    const decision = decisions.get(item.id);
    if (decision) result.set(item.id, decision.contentHash === await contentHash(item, hash)
      ? decision.outcome : "conflict");
  }
  return result;
}
