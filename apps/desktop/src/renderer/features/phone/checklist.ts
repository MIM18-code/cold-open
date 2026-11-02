import type { PhoneTailscale } from "../../../shared/channels/phone.ts";

// Plain-language setup steps for a writer who wants the Phone remote to work away from home. Each step is either
// done or shows one action. No address, port or file path appears here.
export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
export const TAILSCALE_ADMIN_DNS = "https://login.tailscale.com/admin/dns";

export interface ChecklistInput {
  tailscale: PhoneTailscale;
  remembered: number;
  folderChosen: boolean;
}

export interface ChecklistStep {
  id: "installed" | "running" | "magicDns" | "https" | "iphone" | "folder";
  title: string;
  /** What to do next, in one sentence, when the step is not done. */
  detail: string;
  done: boolean;
  optional?: boolean;
  action?: { label: string; url: string };
}

export function setupChecklist({ tailscale, remembered, folderChosen }: ChecklistInput): ChecklistStep[] {
  return [
    {
      id: "installed", title: "Tailscale is installed on this Mac", done: tailscale.installed,
      detail: "Install Tailscale on this Mac.",
      action: tailscale.installed ? undefined : { label: "Install Tailscale", url: TAILSCALE_DOWNLOAD },
    },
    {
      id: "running", title: "Tailscale is signed in and running", done: tailscale.running,
      detail: "Open Tailscale on this Mac and sign in.",
    },
    {
      id: "magicDns", title: "MagicDNS is on", done: tailscale.magicDns,
      detail: "Turn on MagicDNS in the Tailscale admin console.",
      action: tailscale.magicDns ? undefined : { label: "Open Tailscale admin", url: TAILSCALE_ADMIN_DNS },
    },
    {
      id: "https", title: "HTTPS certificates are on", done: tailscale.https,
      detail: "Turn on HTTPS Certificates in the Tailscale admin console.",
      action: tailscale.https ? undefined : { label: "Open Tailscale admin", url: TAILSCALE_ADMIN_DNS },
    },
    {
      id: "iphone", title: "An iPhone is remembered", done: remembered > 0,
      detail: "Start pairing below and tick Remember this iPhone.",
    },
    {
      id: "folder", title: "An iCloud Drive folder is chosen", done: folderChosen, optional: true,
      detail: "Choose the same folder on this Mac and on the iPhone.",
    },
  ];
}
