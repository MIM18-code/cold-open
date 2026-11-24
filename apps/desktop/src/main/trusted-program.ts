// Which programs outside its own bundle a signed release of the app may run. macOS treats a child process of the
// signed app as the app for microphone access, so a program that any process running as this user could have put
// in place (a settings file, ~/Applications, /opt/homebrew/bin) must not run just because it sits at a known path.
//
// A build is sealed when it is packaged and its own code signature names a team. Development builds, tests and the
// ad hoc package the pre-seal Playwright stage drives are not, and run every program as before. In a sealed build a
// program runs only if codesign confirms the expected signature on its resolved path. No location gets a pass: under
// /System is /System/Volumes/Data, the writable data volume, and the bundle's path is not tied to the running code once
// the app is moved. The app's own programs pass anyway, being signed by its team.
//
// This file has no Electron imports so tests can drive it; trusted-program-setup.ts configures it in the app.
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";

export const OLLAMA_TEAM = "3MU9H2V9Y9"; // Infra Technologies, Inc
export const TAILSCALE_TEAM = "W5364U7YZB"; // Tailscale Inc.
const TAILSCALE_APP_STORE_ID = "io.tailscale.ipn.macos";

const CODESIGN = "/usr/bin/codesign";

export type Exec = (file: string, args: string[]) => Promise<{ code: number; output: string }>;

/** Runs a command and reports its exit code and combined output; codesign writes its details to stderr. */
export const execCommand: Exec = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 30_000 }, (error, stdout, stderr) => {
    const code = !error ? 0 : typeof error.code === "number" ? error.code : -1;
    resolve({ code, output: `${stdout}${stderr}` });
  });
});

export interface PackagedApp {
  /** The team in the app's own signature, or null for an ad hoc or unsigned package. Rejects when it can't tell. */
  team(): Promise<string | null>;
  exec?: Exec;
}

let packaged: PackagedApp | null = null;

/** Set once at startup in a packaged app. Left null in development and tests. */
export function configurePackagedApp(value: PackagedApp | null): void {
  packaged = value;
}

export function isPackagedApp(): boolean {
  return packaged !== null;
}

/** The TeamIdentifier line of `codesign -dv`, or null when it is missing or "not set" (ad hoc). */
export function parseTeam(output: string): string | null {
  return /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(output)?.[1] ?? null;
}

/**
 * Any Apple-issued certificate of the team: Developer ID, Apple Development or Apple Distribution. Used only for the
 * app's own team, so a build someone signs with their own development certificate still accepts its own helper.
 */
export function teamRequirement(team: string): string {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`Not a team identifier: ${team}`);
  return `anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
}

/** A Developer ID Application certificate of the team, as a vendor ships outside the App Store. */
export function developerIdRequirement(team: string): string {
  return `${teamRequirement(team)} and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
}

/**
 * An app Apple re-signed for the Mac App Store. Its leaf certificate names no team, so the bundle identifier, which
 * the App Store lets only one developer use, stands for the vendor.
 */
export function appStoreRequirement(identifier: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(identifier)) throw new Error(`Not a bundle identifier: ${identifier}`);
  return `anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.9] exists and identifier "${identifier}"`;
}

/** The codesign requirement a program must meet, given the app's own team. */
export type Signer = (ownTeam: string) => string;
/** The team that signed this copy of the app, whoever built it, so a self-signed build accepts its own helpers. */
export const OWN_SIGNER: Signer = (team) => teamRequirement(team);
export const OLLAMA_SIGNER: Signer = () => developerIdRequirement(OLLAMA_TEAM);
// The App Store branch follows the shape of an App Store app's designated requirement on this Mac; it has not been
// checked against a real App Store install of Tailscale.
export const TAILSCALE_SIGNER: Signer = () =>
  `(${developerIdRequirement(TAILSCALE_TEAM)}) or (${appStoreRequirement(TAILSCALE_APP_STORE_ID)})`;

/**
 * The team of the running process, or null for an ad hoc or unsigned package. codesign reads the code the kernel
 * loaded for that pid, so moving or replacing the bundle on disk afterwards changes nothing; a path would also put
 * text the launcher chose (the folder name) into the output being matched. Read once per process. Any answer other
 * than a team, "not set" or this pid's exact "not signed at all" line (codesign failed to start, timed out, was
 * killed, or printed something unexpected) rejects and is not kept, so a failure never reads as unsealed and the next
 * check asks again.
 */
export function ownTeam(pid: number = process.pid, exec: Exec = execCommand): () => Promise<string | null> {
  let team: Promise<string | null> | undefined;
  return () => (team ??= exec(CODESIGN, ["-dv", "--verbose=2", String(pid)]).then(({ code, output }) => {
    if (code === 0) {
      // codesign prints the path the app was launched from without escaping it, so a folder name that holds a
      // line break can add a TeamIdentifier line of its own. Exactly one such line is the real one; with more,
      // the output cannot be trusted.
      const lines = output.split("\n").filter((line) => line.startsWith("TeamIdentifier="));
      if (lines.length === 1) {
        const named = parseTeam(lines[0]!);
        if (named) return named;
        if (lines[0] === "TeamIdentifier=not set") return null;
      }
    } else if (output.trim() === `${pid}: code object is not signed at all`) return null;
    throw new Error(`codesign could not read the app's signature: ${code}`);
  }).catch((error: unknown) => {
    team = undefined;
    throw error;
  }));
}

type Verdict = { kind: "run"; path: string } | { kind: "refuse" } | { kind: "check"; path: string; requirement: string; app: PackagedApp };

async function decide(path: string, signer: Signer, app: PackagedApp | null): Promise<Verdict> {
  if (!app) return { kind: "run", path };
  let team: string | null;
  try { team = await app.team(); } catch { return { kind: "refuse" }; }
  if (!team) return { kind: "run", path };
  let real: string;
  try { real = await realpath(path); } catch { return { kind: "refuse" }; }
  return { kind: "check", path: real, requirement: signer(team), app };
}

async function meets(path: string, requirement: string, app: PackagedApp): Promise<boolean> {
  const { code } = await (app.exec ?? execCommand)(CODESIGN, ["--verify", "--strict", `-R=${requirement}`, path]);
  return code === 0;
}

/**
 * The path to run, or null when it must not run. In a sealed build that is the resolved path, so the caller runs
 * the file that was checked. A file can still be swapped between this check and the start; closing that would need
 * the kernel to check the signature at exec time, and the swap needs the same write access the check is about.
 */
export async function trustedProgram(path: string, signer: Signer): Promise<string | null> {
  const verdict = await decide(path, signer, packaged);
  if (verdict.kind !== "check") return verdict.kind === "run" ? verdict.path : null;
  return (await meets(verdict.path, verdict.requirement, verdict.app)) ? verdict.path : null;
}

/**
 * trustedProgram for a program checked every few seconds: one codesign run per resolved file, again only when the
 * file changes.
 */
export function cachedTrust(signer: Signer): (path: string) => Promise<string | null> {
  const verdicts = new Map<string, { key: string; ok: boolean }>();
  return async (path) => {
    const verdict = await decide(path, signer, packaged);
    if (verdict.kind !== "check") return verdict.kind === "run" ? verdict.path : null;
    let key: string;
    // Size and mtime can be copied onto a replacement with `touch -r`; the inode and ctime cannot.
    try { const info = await stat(verdict.path); key = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; } catch { return null; }
    let cached = verdicts.get(verdict.path);
    if (cached?.key !== key) {
      cached = { key, ok: await meets(verdict.path, verdict.requirement, verdict.app) };
      verdicts.set(verdict.path, cached);
    }
    return cached.ok ? verdict.path : null;
  };
}
