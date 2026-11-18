// The Electron fuses a release ships with, and a reader for the fuses a built app actually has. Fuses are switches
// stored in the Electron binary itself, so the code signature covers them.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

/** Keyed as electron-builder's `electronFuses` option names them. */
export const releaseFuses = {
  // Off. Each of these let any program running as the writer start the signed app with its own code in the main
  // process, which can decrypt the stored AI keys and ChatGPT tokens and holds the app's microphone permission:
  // ELECTRON_RUN_AS_NODE, NODE_OPTIONS, and --inspect.
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  // On. The app runs only Resources/app.asar, and only while its header matches the hash in Info.plist.
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  // Stays on. The window loads file://…/app.asar/dist/renderer/index.html, and with this fuse off Electron no longer
  // serves file: URLs from inside app.asar: the page fails with ERR_FILE_NOT_FOUND (tested on Electron 44.2.0 and 44.11.3).
  // It can go off once the page is served from a custom protocol.
  grantFileProtocolExtraPrivileges: true,
};

const ENABLED = 0x31, DISABLED = 0x30;

/** A built app's fuses as { name: true | false }. Fuses this Electron removed, or newer than the library, are left out. */
export async function readFuses(app) {
  const wire = await getCurrentFuseWire(app);
  const fuses = {};
  for (const [index, state] of Object.entries(wire)) {
    const key = FuseV1Options[index];
    if (key && (state === ENABLED || state === DISABLED)) fuses[key[0].toLowerCase() + key.slice(1)] = state === ENABLED;
  }
  return fuses;
}

/** What is wrong with a built app's fuses and ASAR hash for a release, one line each. Empty when all is right. */
export async function fuseProblems(app) {
  const fuses = await readFuses(app);
  const problems = Object.entries(releaseFuses).filter(([name, wanted]) => fuses[name] !== wanted)
    .map(([name, wanted]) => `${name} is ${fuses[name] === undefined ? "missing" : fuses[name] ? "on" : "off"}, expected ${wanted ? "on" : "off"}`);
  let recorded;
  try {
    recorded = JSON.parse(execFileSync("/usr/bin/plutil", ["-extract", "ElectronAsarIntegrity", "json", "-o", "-", join(app, "Contents/Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))["Resources/app.asar"];
  } catch { /* reported below */ }
  if (recorded?.algorithm !== "SHA256") problems.push("Info.plist has no SHA256 ElectronAsarIntegrity entry for Resources/app.asar");
  else if (recorded.hash !== asarHeaderHash(join(app, "Contents/Resources/app.asar"))) problems.push("the app.asar header does not match the hash in Info.plist");
  return problems;
}

/** The hash Electron checks: SHA-256 of the archive's JSON header, which lists a hash for every file inside. */
function asarHeaderHash(asar) {
  const file = openSync(asar, "r");
  try {
    // Two Pickle objects: a 4-byte size, then the header as a length-prefixed string.
    const sizes = Buffer.alloc(16);
    readSync(file, sizes, 0, 16, 0);
    const header = Buffer.alloc(sizes.readUInt32LE(12));
    readSync(file, header, 0, header.length, 16);
    return createHash("sha256").update(header).digest("hex");
  } finally { closeSync(file); }
}

export const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
