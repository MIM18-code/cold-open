import type { Pairing } from "./pairing.ts";

// A remembered iPhone that cannot reach the Mac explains why in plain words. The iPhone cannot see Tailscale's
// state, so the tailnet message names the likely causes rather than guessing one.
export type ReachReason = "script-closed" | "unreachable";

export const isTailnet = (pair: Pairing) => new URL(pair.origin).hostname.endsWith(".ts.net");

export function reachStatus(reason: ReachReason, options: { tailnet: boolean; folder: boolean }): string {
  const later = options.folder
    ? "Waiting takes will go to iCloud, or send later."
    : "Waiting takes will stay on this iPhone and send later.";
  if (reason === "script-closed") return `The script is not open on the Mac. ${later}`;
  const unreachable = options.tailnet
    ? "Can’t reach the Mac. Tailscale may be off on this iPhone, or the Mac may be asleep or Cold Open may be closed."
    : "Can’t reach the Mac. The Mac may be asleep or Cold Open may be closed, or this iPhone may be off your Wi-Fi.";
  return `${unreachable} ${later}`;
}
