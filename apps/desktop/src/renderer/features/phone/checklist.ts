import type { PhoneTailscale } from "../../../shared/channels/phone.ts";

// Plain-language setup steps for a writer who wants the Phone remote to work away from home. Each step is either
// done or says what to do, naming the button to press. No address, port or file path appears here.
export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
export const TAILSCALE_ADMIN_DNS = "https://login.tailscale.com/admin/dns";

export interface ChecklistInput {
  tailscale: PhoneTailscale;
  /** This window's remembered iPhones. */
  remembered: { tailscale?: boolean; lastSeen: number }[];
  folderChosen: boolean;
  /** A pairing code is on screen, which hides Connect through. The iPhone step says how to get it back. */
  showing?: "one-off" | "remembered";
}

/**
 * An iPhone that works away from home: paired through Tailscale, and it has connected. A home pairing does not
 * count, and neither does a code that was shown and never scanned.
 */
export const pairedForAway = (remembered: ChecklistInput["remembered"]) =>
  remembered.some(device => device.tailscale === true && device.lastSeen > 0);

export interface ChecklistStep {
  id: "installed" | "running" | "magicDns" | "https" | "iphone" | "folder";
  title: string;
  /** What to do next when the step is not done. */
  detail: string;
  done: boolean;
  optional?: boolean;
  action?: { label: string; url: string };
}

export function setupChecklist({ tailscale, remembered, folderChosen, showing }: ChecklistInput): ChecklistStep[] {
  const back = showing === "remembered" ? " A pairing code is showing now: choose Pair another iPhone to bring Connect through back."
    : showing === "one-off" ? " A pairing code is showing now: choose Stop sharing / revoke link to bring Connect through back." : "";
  return [
    {
      id: "installed", title: "Tailscale is installed on this Mac", done: tailscale.installed,
      detail: tailscale.refused
        ? "This Mac has a Tailscale that Cold Open can't use, such as one installed with Homebrew. Install Tailscale from its website or the App Store."
        : "Install Tailscale on this Mac.",
      action: tailscale.installed ? undefined : { label: "Install Tailscale", url: TAILSCALE_DOWNLOAD },
    },
    {
      id: "running", title: "Tailscale is signed in and running", done: tailscale.running,
      detail: "Open Tailscale on this Mac and sign in, or make an account.",
    },
    {
      id: "magicDns", title: "MagicDNS is on", done: tailscale.magicDns,
      detail: "On Tailscale’s DNS page, turn on MagicDNS. It gives this Mac a name the iPhone can find.",
      action: tailscale.magicDns ? undefined : { label: "Open Tailscale’s DNS page", url: TAILSCALE_ADMIN_DNS },
    },
    {
      id: "https", title: "HTTPS certificates are on", done: tailscale.https,
      detail: "On Tailscale’s DNS page, find HTTPS Certificates and choose Enable HTTPS. When you pair, Cold Open " +
        "gets a certificate that lists this Mac’s Tailscale name in a public record. Rename the Mac on Tailscale’s " +
        "Machines page first if its name is private.",
      action: tailscale.https ? undefined : { label: "Open Tailscale’s DNS page", url: TAILSCALE_ADMIN_DNS },
    },
    {
      id: "iphone", title: "An iPhone has paired through Tailscale", done: pairedForAway(remembered),
      detail: "Install Tailscale on the iPhone and sign in with the same account. Then, with the iPhone here at " +
        "the Mac, choose Tailscale under Connect through, tick Remember this iPhone and start pairing." + back,
    },
    {
      id: "folder", title: "This Mac has an iCloud Drive folder", done: folderChosen, optional: true,
      detail: "Optional. The iPhone saves what you write there when it can’t reach the Mac, and it arrives here once " +
        "iCloud syncs. Choose the folder further down this panel, and the same one in the iPhone’s Status screen.",
    },
  ];
}

/**
 * Whether Use from anywhere shows open. Otherwise it is one row the writer can open, so someone who only uses the
 * iPhone at home isn't handed a long setup list. Finishing any step keeps it open from then on.
 */
export const checklistOpen = (steps: ChecklistStep[], awayCodeShowing: boolean) =>
  awayCodeShowing || steps.some(step => step.done);
