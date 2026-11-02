import { signTake, type Sha256 } from "./signing.ts";
import type { Pairing } from "./pairing.ts";
import { inboxBody, validateTakeSize, type Take } from "./outbox.ts";

// The AirDrop fallback when the iPhone and the Mac share no network at all. The file carries the same per-take
// fields as one iCloud folder file, with the device and script identity once at the top.
export const MAX_TAKES = 100;
const waiting: Take["outcome"][] = ["pending", "saved", "airdropped"];

export function isWaiting(t: Take) {
  return waiting.includes(t.outcome);
}

/** Takes still owed to the Mac for this pairing; sent ones stay here until the Mac reports a decision. */
export function waitingTakes(pair: Pairing, takes: Take[]): Take[] {
  return takes.filter(t => t.room === pair.invite.room && isWaiting(t));
}

export function unsentTakes(pair: Pairing, takes: Take[]): Take[] {
  return waitingTakes(pair, takes).filter(t => t.outcome !== "airdropped")
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}

export function takesBatch(pair: Pairing, takes: Take[]): Take[] {
  return unsentTakes(pair, takes).slice(0, MAX_TAKES);
}

export function takesFileName(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0"), day = String(now.getDate()).padStart(2, "0");
  return `Cold Open takes ${now.getFullYear()}-${month}-${day}.coldopentakes`;
}

/** The JSON written to the shared file. Throws when the pairing or a take cannot travel by AirDrop. */
export async function takesFile(pair: Pairing, items: Take[], hash?: Sha256): Promise<string> {
  if (!pair.remembered || !pair.deviceId || !pair.scriptId)
    throw new Error("Remember this iPhone on the Mac before sending takes.");
  if (!items.length) throw new Error("There are no waiting takes to send.");
  const batch = [...items].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
    .slice(0, MAX_TAKES);
  const { deviceId, scriptId } = pair;
  const takes = await Promise.all(batch.map(async item => {
    if (item.room !== pair.invite.room) throw new Error("This take belongs to a different pairing.");
    validateTakeSize(item);
    return { ...inboxBody(item), sig: await signTake(pair.token, deviceId, scriptId, item, hash) };
  }));
  return JSON.stringify({ v: 1, deviceId: pair.deviceId, scriptId: pair.scriptId, takes });
}
