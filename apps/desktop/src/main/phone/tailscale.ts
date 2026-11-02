import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { openForRead } from "../safe-fs.ts";
import type { PhoneTailscale } from "../../shared/channels/phone.ts";
import { phoneTls, type PhoneTls } from "./tls.ts";

const execute = promisify(execFile);
const binaries = ["/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
export const tailAddress = (s: string) => /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/.test(s)
  && s.split(".").every(n => Number(n) <= 255);
export const tailName = (s: string) => s.length <= 253
  && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(s);
export type TailNetwork = { address: string; name: string; hostname?: string; cli?: string; tailscale: true };
export type RunTail = (file: string, args: string[]) => Promise<string>;
const run: RunTail = async (file, args) => (await execute(file, args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
export function tailStatus(raw: string): { address?: string; hostname?: string } {
  const status = JSON.parse(raw);
  if (status.BackendState !== "Running") return {};
  const hostname = String(status.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
  return { address: status.Self?.TailscaleIPs?.find((ip: unknown) => typeof ip === "string" && tailAddress(ip)),
    hostname: tailName(hostname) ? hostname : undefined };
}
/** The checklist answers, read without trusting any field as a path or address. */
export function tailStatusFields(raw: string): Omit<PhoneTailscale, "installed"> {
  const status = JSON.parse(raw);
  return {
    running: status?.BackendState === "Running",
    magicDns: status?.CurrentTailnet?.MagicDNSEnabled === true,
    https: Array.isArray(status?.CertDomains) && status.CertDomains.some((name: unknown) => typeof name === "string" && !!name),
  };
}
/**
 * Whether Tailscale is installed, signed in, has MagicDNS and can issue HTTPS certificates. Returns booleans only,
 * so the Phone panel can explain the next step without any address, port or file path reaching the renderer.
 */
export async function tailscaleCheck(exec: RunTail = run): Promise<PhoneTailscale> {
  for (const cli of binaries) {
    let raw: string;
    try { raw = await exec(cli, ["status", "--json"]); } catch { continue; }
    try { return { installed: true, ...tailStatusFields(raw) }; } catch { continue; }
  }
  return { installed: false, running: false, magicDns: false, https: false };
}
/** This Mac's Tailscale IPv4 address as Tailscale itself reports it, or null when Tailscale isn't running here. */
export async function tailscaleOwnAddress(exec: RunTail = run): Promise<string | null> {
  for (const cli of binaries) {
    try {
      const { address } = tailStatus(await exec(cli, ["status", "--json"]));
      if (address) return address;
    } catch { /* The other supported installation may own the CLI. */ }
  }
  return null;
}
export async function tailscaleNetwork(exec: RunTail = run): Promise<TailNetwork | null> {
  for (const cli of binaries) {
    try {
      const status = tailStatus(await exec(cli, ["status", "--json"]));
      const address = status.address ?? (await exec(cli, ["ip", "-4"])).trim();
      if (tailAddress(address)) return { address, hostname: status.hostname, cli, tailscale: true,
        name: "Tailscale · works away from home" };
    } catch { /* The other supported installation may own the CLI. */ }
  }
  for (const rows of Object.values(networkInterfaces())) {
    const ip = rows?.find(r => r.family === "IPv4" && tailAddress(r.address));
    if (ip) return { address: ip.address, name: "Tailscale · works away from home", tailscale: true };
  }
  return null;
}
async function pem(path: string, limit: number) {
  const file = await openForRead(path);
  if (!file) throw new Error("Tailscale did not write a certificate.");
  try {
    if (file.info.size > limit) throw new Error("Tailscale certificate exceeds its size limit.");
    return new TextDecoder().decode(await file.read(limit));
  } finally { await file.close(); }
}
export async function tailscaleTls(root: string, network: TailNetwork, exec: RunTail = run): Promise<PhoneTls> {
  if (!network.hostname || !tailName(network.hostname) || !binaries.includes(network.cli ?? ""))
    throw new Error("Cold Open needs the Tailscale CLI and this Mac’s MagicDNS name. Enable MagicDNS in the Tailscale DNS settings.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(join(root, "phone-tls-"));
  try {
    const cert = join(folder, "server.crt"), key = join(folder, "server.key");
    await exec(network.cli!, ["cert", `--cert-file=${cert}`, `--key-file=${key}`, network.hostname]);
    await chmod(key, 0o600);
    return phoneTls(await pem(cert, 256000), await pem(key, 32000), network.hostname);
  } catch {
    throw new Error("Tailscale could not obtain HTTPS. In the Tailscale admin console, open DNS, enable MagicDNS, " +
      "then HTTPS Certificates → Enable HTTPS. This publishes the Mac’s DNS name in certificate transparency logs. " +
      "Retry here after enabling it. If already enabled, check that this Mac’s Tailscale CLI can issue certificates. " +
      "No HTTP fallback was used.");
  } finally { await rm(folder, { recursive: true, force: true }); }
}
