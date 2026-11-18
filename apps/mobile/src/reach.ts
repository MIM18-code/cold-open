import { PAIR_AGAIN, type Pairing } from "./pairing.ts";

// A remembered iPhone that cannot reach the Mac explains why in plain words. The iPhone cannot see Tailscale's
// state, so the tailnet message names the likely causes rather than guessing one. A home pairing says that it
// stops at the Mac's network, and what to do once back at the Mac: nothing else tells a writer on the road why it went
// quiet. Pairing needs the code on the Mac's screen, so the message does not send them to pair from where they are.
export type ReachReason = "script-closed" | "unreachable";

export const isTailnet = (pair: Pairing) => new URL(pair.origin).hostname.endsWith(".ts.net");

export function reachStatus(reason: ReachReason, options: { tailnet: boolean; folder: boolean }): string {
  const later = options.folder
    ? "Unsent items go to your iCloud Drive folder, or send when the Mac is reachable."
    : "Unsent items stay on this iPhone and send when the Mac is reachable.";
  if (reason === "script-closed") return `The script is not open on the Mac. ${later}`;
  const unreachable = options.tailnet
    ? "Can’t reach the Mac. Tailscale may be off on this iPhone or on the Mac, or the Mac may be asleep or Cold Open may be closed."
    : "Can’t reach the Mac. This pairing works only on the Mac’s home network, and the Mac may be asleep or Cold Open may be closed. " +
      "To use this iPhone away from home, pair through Tailscale when you are back at the Mac.";
  return `${unreachable} ${later}`;
}

export const pairingEnded = (status: string) =>
  ["Pairing expired", "Refused", "Host stopped sharing", "This Mac revoked the pairing", PAIR_AGAIN].includes(status);
